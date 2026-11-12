/**
 * Lector de tendencia: ventana transparente siempre encima.
 *
 * Dos veces por segundo captura la zona marcada de la grafica, lee las velas y
 * la linea de precio, calcula la senal (arriba / abajo / esperar) y actualiza
 * el marcador que mide cuantas senales aciertan de verdad.
 *
 * Dos modos:
 *   - Por segundos (config.cycleSeconds > 0): da una senal, espera N segundos,
 *     la califica con el movimiento del precio y da la siguiente.
 *   - Por vela (cycleSeconds = 0): una senal por cada vela que cierra.
 *
 * Solo MUESTRA: no hace clic ni apuesta.
 */
const { app, BrowserWindow, ipcMain, screen, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { captureScreen, cropRegion, toPixels, CROP_INSET } = require('./src/capture');
const { readCandles, findPriceLine, findPriceLabel } = require('./src/candles');
const { createTracker } = require('./src/tracker');
const { createTimedTracker, tickMomentum } = require('./src/timed');
const { createHistory } = require('./src/history');
const { computeReadings } = require('./src/readings');
const { createQualityGate, createStabilityCheck } = require('./src/quality');
const { readAxis } = require('./src/axis');
const { measureRegime } = require('./src/regime');
const { createMarketMemory, segmentsOf, segmentCount } = require('./src/memory');
const { costOf } = require('./src/prices');
const { summarize } = require('./src/score');
const { findResultBadges, viewJumped, createBadgeCounter } = require('./src/badges');
const { MIN_CANDLES } = require('./src/signal');
const { describeChart } = require('./src/ai');
const { PROVIDERS } = require('./src/providers');
const { combine, nickname, scoreVotes, rememberOutcome, feedbackFor, PROVIDER_ORDER } = require('./src/council');

const FEW_CANDLES = 8; // con menos velas a la vista se avisa (sigue funcionando)
const SCAN_INTERVAL_MS = 300; // cada cuanto se lee la pantalla (velas y linea de precio)
const AI_MIN_PAUSE_SECONDS = 3; // la IA necesita al menos este tiempo para contestar
const AI_LEAD_MS = 2500; // modo automatico: la consulta sale este tiempo antes de que termine la senal
const AI_MANUAL_EXTRA_MS = 5000; // modo manual: cuanto mas se espera a la IA pasada la pausa
// Retraso de entrada: lo que tarda el usuario en poner la orden despues de ver la senal. Se
// estima solo, comparando cuando aparece la senal con cuando la plataforma muestra el globo
// del resultado (ese globo sale al cerrar la operacion, es decir, entrada + duracion).
const ENTRY_MAX_MS = 4000;
const BADGE_LAG_MS = 500; // lo que tarda el panel en confirmar un globo (dos lecturas seguidas)
// Cuanto precio se recuerda (para "Mov. 1 min" y el patron medido). El patron necesita al menos
// 24 tramos del tamano de la operacion, asi que con operaciones largas hay que recordar mas:
// 10 minutos como minimo, o 40 tramos (40 minutos si la operacion dura 1 minuto).
const trackMemoryMs = () => Math.max(10 * 60 * 1000, 40 * config.cycleSeconds * 1000);
const TRACK_STEP_MS = 250; // como mucho una cotizacion guardada cada 250 ms
// Con operaciones de 30 s o mas se mira un poco mas de historia: 20 velas en vez de 12.
const longTrade = () => config.cycleSeconds >= 30;
const GOOD_CANDLES_MS = 30000; // cuanto valen las ultimas velas bien leidas mientras algo tapa la grafica

let win = null;
let busy = false;
let auto = true;
// payout = % que paga la plataforma al acertar; cycleSeconds = 0 -> modo por vela.
// pauseSeconds = segundos de analisis entre una senal y la siguiente (modo por segundos).
// alwaysSignal = dar siempre ARRIBA o ABAJO (nunca ESPERAR), marcando las de confianza baja.
// manual = predecir solo cuando el usuario pulsa PREDECIR; asset = nombre del activo (contexto para la IA).
const config = {
  region: null,
  payout: 85,
  cycleSeconds: 5,
  pauseSeconds: 5,
  alwaysSignal: true,
  manual: true,
  asset: '',
  instant: false, // con boton: dar la senal al instante, sin pausa ni espera a la IA
};
/** Senal al instante: solo aplica cuando la prediccion se pide con el boton. */
const instantMode = () => config.instant && config.manual;
const byCandle = createTracker();
const byTime = createTimedTracker();
// Historial largo de velas (se acumula mientras el panel esta abierto) y las 8 lecturas del panel.
// Marcador de comparacion: la senal de las reglas dada al instante de pulsar (ver scanTick).
const shadow = createTimedTracker();
let instantScore = null;
const history = createHistory();
let panel = null;
let longCandles = []; // historial + vela en curso, de la ultima lectura buena
// ---------- Registro en disco ----------
// Guarda el precio real leido (cuando el eje esta a la vista) y cada senal con su resultado, en
// %APPDATA%\senales-overlay\registro\AAAA-MM-DD.csv. Sirve para simular con datos de verdad:
//   node tools/simular.js "ruta\al\archivo.csv"
// Lineas: T,ms,precio,pip   S,ms,direccion,fuente,confianza,segundos,patron   R,ms,resultado
let recordBuffer = [];
function record(line) {
  recordBuffer.push(line);
}
function flushRecord() {
  if (recordBuffer.length === 0) return;
  const lines = recordBuffer;
  recordBuffer = [];
  try {
    const dir = path.join(app.getPath('userData'), 'registro');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date();
    const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.csv`;
    fs.appendFileSync(path.join(dir, name), lines.join('\n') + '\n', 'utf8');
  } catch {
    /* el registro no es critico */
  }
}

// Imagenes automaticas de la zona al terminar cada senal (para diagnostico). Se guardan en
// %APPDATA%\senales-overlay\capturas-auto y solo se conservan las 30 mas recientes.
let autoShots = []; // instantes (ms) en los que toca guardar una
let lastSignalAt = 0; // cuando aparecio la ultima senal (para estimar el retraso de entrada)
let entrySamples = []; // ultimos retrasos de entrada medidos (ms)
const entryMs = () => Math.max(0, Math.min(ENTRY_MAX_MS, config.entryDelayMs || 0));
// Escaner sobre la grafica: mientras se ve, la ventana se oculta a las capturas de pantalla para
// que el haz no se cuele en la lectura de las velas.
let scanUntil = 0;
let scanProtected = false;
let scanEndedAt = 0;
// Se escanea durante el analisis y durante la senal (ahi se sigue la vela actual y la entrada).
const scanningNow = () => config.cycleSeconds > 0 && (last.phase === 'analysis' || last.phase === 'signal' || Date.now() < scanUntil);
let entry = null; // senal en curso: { at, price, taken }
let candleStartedAt = 0; // cuando empezo la vela en curso
function protectForScan(on) {
  if (win && !win.isDestroyed()) win.setContentProtection(on);
  scanProtected = on;
}
function updateScanProtection(now) {
  if (scanningNow()) {
    scanEndedAt = 0;
    if (!scanProtected) protectForScan(true);
  } else if (scanProtected) {
    // Se espera a que el panel haya quitado el haz antes de volver a ser visible a las capturas.
    if (!scanEndedAt) scanEndedAt = now;
    else if (now - scanEndedAt >= 700) protectForScan(false);
  }
}
function saveAutoShot(image, badges) {
  try {
    const dir = path.join(app.getPath('userData'), 'capturas-auto');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '') + '_' + String(Date.now() % 1000).padStart(3, '0');
    const found = badges.map((b) => (b.result === 'win' ? 'G' : b.result === 'tie' ? 'E' : 'P')).join('') || 'sin-globo';
    fs.writeFileSync(path.join(dir, `${stamp}_${found}.png`), image.toPNG());
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(dir, old));
  } catch {
    /* el diagnostico no es critico */
  }
}

// Version del panel, para separar en el registro lo medido antes y despues de cada cambio.
const BUILD = '2026-11-12 lectura con operacion abierta + freno de movimiento agotado + NO ENTRAR en confianza baja';

/**
 * Reloj de la vela en curso, visto desde el momento en que de verdad empezara la operacion:
 * ahora + lo que tardan las IA en contestar + lo que tarda el usuario en entrar.
 */
function candleClock(now, forming) {
  if (!candleStartedAt) return null;
  const waits = enabledAis().map((id) => ais[id].lastMs || 4000);
  const aiMs = anyAi() && !instantMode() ? Math.max(...waits) : 0;
  return {
    elapsed: (now - candleStartedAt + aiMs + entryMs()) / 1000,
    tradeSeconds: config.cycleSeconds,
    formingDir: forming ? forming.dir : 'flat',
  };
}

// Memoria del mercado: cada vela que cierra se guarda en disco, por activo (ver src/memory.js).
// Se crea al arrancar, cuando ya se conoce la carpeta de datos.
let marketMemory = null;
let memoryInfo = null; // lo que dice la memoria sobre la situacion actual: { vote, text, data, total }
const memoryVote = () => (memoryInfo ? { vote: memoryInfo.vote, text: memoryInfo.text } : null);

// Patron medido en el precio real: 'continua', 'rebota' o sin patron claro (ver src/regime.js).
const REGIME_EVERY_MS = 2000;
let regime = null;
let regimeAt = 0;
/** Resumen de las 8 lecturas para la votacion: total, las que siguen el movimiento y las de regreso. */
const panelContext = () => (panel ? { vote: panel.vote, follow: panel.follow, reverse: panel.reverse, text: panel.text } : null);
// Eje de precios leido de la pantalla (ver src/axis.js): precio por pixel, para dar pips.
let axis = null;
let priceText = null; // precio actual leido, ya con sus decimales
let track = []; // cotizaciones reales de los ultimos minutos: { time, value }
let goodCandles = null; // ultimas velas bien leidas: { time, candles }
// Control de calidad de la lectura: detecta cuando la plataforma tapa la grafica.
const quality = createQualityGate();
// Lectura verificada: tres lecturas seguidas de las velas deben coincidir.
const stability = createStabilityCheck();
let scanInfo = null; // lo que el escaner dibuja sobre la grafica: velas leidas, niveles y si esta verificada
let readTimes = []; // instantes de las ultimas lecturas de pantalla (para medir lecturas por segundo)
/** Lecturas de pantalla por segundo, medidas sobre las ultimas. */
function readsPerSecond(now) {
  readTimes = [...readTimes, now].slice(-12);
  if (readTimes.length < 3) return null;
  const seconds = (readTimes[readTimes.length - 1] - readTimes[0]) / 1000;
  return seconds > 0 ? Math.round((10 * (readTimes.length - 1)) / seconds) / 10 : null;
}
let coverReason = null;
// Resultados reales de las operaciones del usuario: los globos verde/rojo de la plataforma.
const badgeCounter = createBadgeCounter();
let trades = { wins: 0, losses: 0, ties: 0, last: '' };
let previousCandles = null; // para notar si la vista de la grafica salto
let previousPhase = 'idle';

// ---------- IA opcional: hasta tres a la vez (ChatGPT, Gemini y Claude) ----------
// Cada clave vive cifrada en disco y en memoria; nunca se envia al panel ni se escribe en logs.
const ais = {};
for (const id of PROVIDER_ORDER) {
  ais[id] = {
    key: null,
    model: null,
    models: [], // modelos de chat que la cuenta tiene de verdad (para elegir en el panel)
    status: 'Sin clave.',
    busy: false,
    lastMs: null, // cuanto tardo en contestar la ultima vez (se le dice, para que prediga desde entonces)
    usage: { calls: 0, input: 0, output: 0, cost: 0, priced: true }, // consumo desde que se abrio el panel
  };
}
// El "consejo": lo que contesto cada IA para la proxima senal, y el marcador de cada una.
const council = {
  asked: false, // ya se les pregunto en este ciclo
  requestId: 0,
  deadlineAt: 0, // hasta cuando se espera a las que faltan
  answers: {}, // por IA: { dir, confidence, reason, name }
  voted: null, // lo que dijo cada IA para la senal en curso (para su marcador)
  votedDir: null, // lado que se mostro en esa senal
  votedAnswers: null, // las respuestas completas de esa senal (para recordarselas a cada IA)
  scores: {}, // por IA: { wins, losses }
  memory: {}, // por IA: sus ultimas predicciones en esta grafica y lo que paso (se les manda)
};
const enabledAis = () => PROVIDER_ORDER.filter((id) => ais[id].key);
const anyAi = () => enabledAis().length > 0;
const anyAiBusy = () => PROVIDER_ORDER.some((id) => ais[id].busy);
const keyFile = (id) => path.join(app.getPath('userData'), PROVIDERS[id].keyFile);

/** Lee la clave guardada (cifrada por Windows para este usuario). Devuelve null si no hay. */
async function loadAiKey(id) {
  try {
    if (!fs.existsSync(keyFile(id))) return null;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(keyFile(id)));
    return result || null;
  } catch {
    return null;
  }
}

/** Guarda la clave cifrada. Si no hay cifrado disponible no se escribe en disco. */
async function storeAiKey(id, key) {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    fs.writeFileSync(keyFile(id), await safeStorage.encryptStringAsync(key));
    return true;
  } catch {
    return false;
  }
}

/** Comprueba la clave con su proveedor y elige un modelo que la cuenta tenga. */
async function activateAi(id, key) {
  const provider = PROVIDERS[id];
  const models = await provider.list(key);
  const model = provider.pick(models, config[provider.configKey]);
  if (!model) throw new Error('Tu cuenta no tiene ningún modelo de chat disponible.');
  const ai = ais[id];
  ai.key = key;
  ai.model = model;
  ai.models = provider.chat(models);
  config[provider.configKey] = model;
  if (id === 'openai') config.aiModelsSeen = ai.models; // solo nombres de modelo (no es informacion secreta)
  saveConfig();
  ai.status = `IA activa · modelo ${model}`;
}

/**
 * Lo que el consejo de IAs dice para la proxima senal, o null si todavia no hay que usarlo.
 * Con boton se espera a que contesten todas (o al plazo); en automatico vale lo que haya.
 */
function councilAdvice(now) {
  if (!anyAi() || instantMode()) return null;
  const combined = combine(council.answers);
  if (!combined) return null;
  if (config.manual && anyAiBusy() && now < council.deadlineAt) return null;
  return { dir: combined.dir, confidence: combined.confidence, reason: `IA: ${combined.reason}` };
}

/** Pregunta a UNA IA y guarda su respuesta en el consejo. */
async function askOne(id, snapshot, timeoutMs, requestId) {
  const ai = ais[id];
  const model = ai.model;
  const startedAt = Date.now();
  ai.busy = true;
  try {
    const answer = await PROVIDERS[id].ask({ key: ai.key, model, snapshot, timeoutMs, force: config.alwaysSignal });
    if (requestId === council.requestId && ai.key) {
      council.answers[id] = { dir: answer.dir, confidence: answer.confidence, reason: answer.reason, name: nickname(id, model) };
      ai.lastMs = Date.now() - startedAt;
      // Consumo real de esta consulta (tokens que informa el proveedor) y su costo aproximado.
      if (answer.usage) {
        const cost = costOf(model, answer.usage);
        ai.usage.calls++;
        ai.usage.input += answer.usage.input;
        ai.usage.output += answer.usage.output;
        if (cost === null) ai.usage.priced = false;
        else ai.usage.cost += cost;
        record(`U,${Date.now()},${id},${model},${answer.usage.input},${answer.usage.output},${ai.lastMs},${cost === null ? '' : cost.toFixed(5)}`);
      }
      ai.status = `IA activa · modelo ${model} · respondió en ${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
    }
  } catch (err) {
    if (requestId !== council.requestId) return; // respuesta de una consulta ya descartada
    const slow = /tardó/.test(err.message) ? ' Elige en ⚙ un modelo más rápido o sube la pausa.' : '';
    ai.status = `IA (${model}): ${err.message}${slow} Esta señal sale sin ella.`;
  } finally {
    ai.busy = false;
  }
}

/**
 * Pide su opinion a todas las IA activas a la vez, con los mismos numeros.
 * @param {number} windowMs  Tiempo que falta para dar la senal: es lo que tienen para contestar.
 */
function askCouncil(candles, moves, ticks, windowMs, readings = null) {
  council.answers = {};
  const ids = enabledAis().filter((id) => !ais[id].busy);
  if (ids.length === 0 || candles.length < MIN_CANDLES) return;
  if (windowMs < AI_MIN_PAUSE_SECONDS * 1000) {
    for (const id of ids) ais[id].status = `IA en espera: pon la pausa de análisis en ${AI_MIN_PAUSE_SECONDS} s o más para darle tiempo.`;
    return;
  }
  const requestId = ++council.requestId;
  council.deadlineAt = Date.now() + windowMs - 400;
  const snapshot = describeChart(candles, moves, config.cycleSeconds, {
    asset: config.asset,
    ticks,
    readings,
    now: tickMomentum(ticks, Date.now()),
    price: priceText,
    regime,
    memory: memoryInfo ? memoryInfo.data : null,
    formation: last.formation || null,
    // Reloj de la vela: cuanto lleva y cuanto dura (para que sepan si la operacion caera en la vela siguiente).
    clock:
      candleStartedAt && memoryInfo && memoryInfo.candleSeconds
        ? { elapsed: Math.round((Date.now() - candleStartedAt) / 100) / 10, seconds: memoryInfo.candleSeconds }
        : null,
  });
  // A cada IA se le agregan SUS predicciones anteriores en esta grafica y lo que paso despues:
  // no recuerdan nada entre consultas, asi que es la unica forma de que puedan corregirse.
  for (const id of ids) {
    const personal = { ...snapshot };
    const feedback = feedbackFor(council.memory[id]);
    if (feedback) personal.tus_ultimas_predicciones = feedback;
    // La operacion se abre cuando llega la respuesta, no cuando se pregunta: se le dice cuanto
    // suele tardar para que prediga el tramo que empieza entonces.
    if (ais[id].lastMs) {
      personal.tu_respuesta_tarda = {
        segundos: Math.round((ais[id].lastMs + entryMs()) / 100) / 10,
        explicacion:
          'lo que tardaste en responder la ultima vez, mas lo que tarda la persona en poner la orden. La operacion se abre entonces: predice donde estara el precio ' +
          `${config.cycleSeconds} segundos DESPUES de ese momento, respecto al precio de ese momento (no respecto al de estos datos)`,
      };
    }
    askOne(id, personal, windowMs - 400, requestId);
  }
}

const emptyResult = () => ({
  status: 'no-chart',
  phase: 'idle',
  signal: null,
  candles: 0,
  lastResult: '',
  remainingMs: 0,
  live: summarize({ wins: 0, losses: 0, ties: 0 }, config.payout),
  visible: null,
});
let last = emptyResult(); // ultimo resultado del lector

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (saved.region) config.region = saved.region;
    if (Number.isFinite(saved.payout)) config.payout = saved.payout;
    if (Number.isFinite(saved.cycleSeconds)) config.cycleSeconds = saved.cycleSeconds;
    if (Number.isFinite(saved.pauseSeconds)) config.pauseSeconds = saved.pauseSeconds;
    if (typeof saved.aiModel === 'string') config.aiModel = saved.aiModel;
    if (typeof saved.geminiModel === 'string') config.geminiModel = saved.geminiModel;
    if (typeof saved.claudeModel === 'string') config.claudeModel = saved.claudeModel;
    if (typeof saved.alwaysSignal === 'boolean') config.alwaysSignal = saved.alwaysSignal;
    if (typeof saved.manual === 'boolean') config.manual = saved.manual;
    if (typeof saved.instant === 'boolean') config.instant = saved.instant;
    if (Number.isFinite(saved.entryDelayMs)) config.entryDelayMs = Math.max(0, Math.min(ENTRY_MAX_MS, saved.entryDelayMs));
    if (typeof saved.asset === 'string') config.asset = saved.asset;
  } catch {
    /* primera ejecucion */
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configFile(), JSON.stringify(config), 'utf8');
  } catch {
    /* no es critico */
  }
}

/** Borra el marcador y lo que cada modo recordaba de la grafica. */
function resetTrackers() {
  byCandle.reset();
  byCandle.update([], config.payout);
  byTime.reset();
  shadow.reset();
  instantScore = null;
  council.scores = {};
  council.memory = {}; // otra medicion (u otra grafica): lo anterior ya no se les recuerda
  council.voted = null;
  council.votedAnswers = null;
  badgeCounter.reset();
  trades = { wins: 0, losses: 0, ties: 0, last: '' };
  previousCandles = null;
  last = emptyResult();
}

/** Fila (en pixeles) donde cierra la vela en curso: ahi debe pasar la linea del precio. */
const closeRow = (candles) => (candles.length ? -candles[candles.length - 1].close : null);

function statusText() {
  if (!config.region) return 'Marca la zona de la gráfica';
  if (!auto) return 'Escáner en pausa';
  if (last.status === 'no-chart') return 'No veo velas verdes y rojas en la zona';
  if (last.status === 'covered' && coverReason) return coverReason;
  if (last.candles < MIN_CANDLES + 1) return `Veo ${last.candles} velas: aleja el zoom, necesito al menos ${MIN_CANDLES + 1}`;
  if (last.status === 'no-price') return 'No encuentro la línea del precio actual dentro de la zona';
  if (last.status === 'resync') return 'La gráfica cambió; vuelvo a sincronizar';
  // Con pocas velas se puede dar señal, pero casi no hay historial con que comparar tamaños.
  if (last.candles < FEW_CANDLES) return `Solo veo ${last.candles} velas: aleja el zoom de la gráfica hasta ver 30 o más y marca la zona completa`;
  return `Leyendo ${last.candles} velas`;
}

function publish(statusOverride) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    auto,
    region: config.region,
    payout: config.payout,
    cycleSeconds: config.cycleSeconds,
    pauseSeconds: config.pauseSeconds,
    alwaysSignal: config.alwaysSignal,
    manual: config.manual,
    instant: config.instant,
    // Aciertos de la senal de reglas al instante, para comparar con la senal mostrada.
    instantScore: config.manual && config.cycleSeconds > 0 ? instantScore : null,
    asset: config.asset,
    ready: Boolean(last.ready), // modo manual: se puede pulsar PREDECIR
    phase: last.phase || 'idle',
    status: statusOverride || statusText(),
    signal: last.signal,
    readings: last.readings || null, // lecturas en vivo (tendencia, vela actual, precio)
    // Las 8 lecturas del panel (sin los datos internos) y cuantas velas hay en el historial.
    panel:
      panel && config.cycleSeconds > 0
        ? panel.items.map((r) => ({ key: r.key, name: r.name, text: r.text, lean: r.lean, spark: r.spark || null, detail: r.detail }))
        : null,
    historyCandles: panel ? panel.candles : 0,
    price: config.cycleSeconds > 0 ? priceText : null, // precio actual leido del eje (null si no se ve el eje)
    pips: Boolean(axis), // las distancias salen en pips
    scanning: scanningNow(), // se esta escaneando la grafica
    scan: scanningNow() ? scanInfo : null, // lo que se dibuja durante el escaneo
    entryDelay: Math.round(entryMs() / 100) / 10, // segundos que tarda el usuario en entrar tras la senal
    // Patron medido en el precio real de esta grafica, al plazo de la senal.
    regime: regime && config.cycleSeconds > 0 ? { kind: regime.kind, text: regime.text } : null,
    // Memoria del mercado: que paso otras veces tras una racha de velas como la actual.
    memory: memoryInfo && config.cycleSeconds > 0 ? { text: memoryInfo.text, votes: memoryInfo.vote !== 0, total: memoryInfo.total } : null,
    trades: { ...summarize(trades, config.payout), last: trades.last },
    live: last.live,
    visible: last.visible,
    lastResult: last.lastResult,
    remainingSeconds: Math.ceil((last.remainingMs || 0) / 1000),
    remainingMs: last.remainingMs || 0,
    // Resumen de las IA activas (para la barra y el contador).
    ai: {
      enabled: anyAi(),
      count: enabledAis().length,
      ids: enabledAis(),
      model: enabledAis().length === 1 ? ais[enabledAis()[0]].model : null,
      names: enabledAis().map((id) => nickname(id, ais[id].model)),
    },
    // Cada IA por separado. De la clave solo se muestran sus ultimos 4 caracteres.
    providers: Object.fromEntries(
      PROVIDER_ORDER.map((id) => [
        id,
        {
          enabled: Boolean(ais[id].key),
          status: ais[id].status,
          hint: ais[id].key ? `…${ais[id].key.slice(-4)}` : '',
          model: ais[id].model,
          models: ais[id].models,
          usage: ais[id].usage,
          seconds: ais[id].lastMs ? Math.round(ais[id].lastMs / 100) / 10 : null,
        },
      ]),
    ),
    // Marcador de cada IA: cuantas veces acerto hacia donde fue el precio.
    aiScores: PROVIDER_ORDER.filter((id) => council.scores[id]).map((id) => ({
      name: nickname(id, ais[id].model),
      wins: council.scores[id].wins,
      losses: council.scores[id].losses,
    })),
  });
}

async function scanTick() {
  if (busy || !auto || !config.region) return;
  busy = true;
  try {
    const shot = await captureScreen();
    const image = cropRegion(shot, config.region);
    const pixels = toPixels(image);
    const candles = readCandles(pixels.data, pixels.width, pixels.height);

    // Globos de resultado de la plataforma (verde = ganada, rojo = perdida).
    const badges = findResultBadges(pixels.data, pixels.width, pixels.height);
    const tradesBefore = trades.wins + trades.losses + (trades.ties || 0);
    trades = badgeCounter.update(badges, Date.now(), viewJumped(previousCandles, candles));
    previousCandles = candles;
    // Registro: cada operacion que la plataforma marca como ganada o perdida.
    if (trades.wins + trades.losses + (trades.ties || 0) !== tradesBefore) {
      record(`B,${Date.now()},${trades.last},${trades.wins},${trades.losses},${trades.ties || 0}`);
      // El globo sale al cerrar la operacion: senal + lo que tardo en entrar + duracion.
      const sample = Date.now() - lastSignalAt - config.cycleSeconds * 1000 - BADGE_LAG_MS;
      if (lastSignalAt && sample > -700 && sample < ENTRY_MAX_MS + 2000) {
        entrySamples = [...entrySamples, Math.max(0, sample)].slice(-12);
        if (entrySamples.length >= 3) {
          const sorted = [...entrySamples].sort((a, b) => a - b);
          config.entryDelayMs = Math.min(ENTRY_MAX_MS, Math.round(sorted[Math.floor((sorted.length - 1) / 2)] / 100) * 100);
          saveConfig();
        }
      }
      lastSignalAt = 0;
    }
    if (autoShots.length && Date.now() >= autoShots[0]) {
      autoShots.shift();
      saveAutoShot(image, badges);
    }

    if (config.cycleSeconds > 0) {
      const now = Date.now();
      // Donde esta el precio. Primero la etiqueta azul del eje (nada la tapa); la linea del
      // precio debe pasar por ahi. Si el eje no esta a la vista, por el cierre de la vela en curso.
      const labelRow = findPriceLabel(pixels.data, pixels.width, pixels.height);
      let priceY = findPriceLine(pixels.data, pixels.width, pixels.height, labelRow !== null ? labelRow : closeRow(candles));
      if (labelRow !== null && (priceY === null || Math.abs(priceY - labelRow) > 4)) priceY = Math.round(labelRow);

      // Que partes de la lectura son de fiar (un aviso o un globo de la plataforma puede tapar velas).
      const check = quality.inspect(candles, priceY, now);
      // Lectura verificada: ademas, las velas deben coincidir con las dos lecturas anteriores.
      const verified = stability.check(candles);
      const formingOk = check.forming && check.complete && verified;
      const forming = candles[candles.length - 1] || null;

      // Eje de precios: se lee en cada lectura (es barato: recuerda los digitos ya vistos).
      // Da la cotizacion real, que no depende de las velas.
      const read = readAxis(pixels.data, pixels.width, pixels.height, forming ? forming.x1 + 4 : 0);
      axis = read;
      const price = axis && axis.anchored && priceY !== null ? axis.at(priceY) : null;
      const quote = price === null ? null : { value: price, perPixel: axis.perPixel };
      priceText = price === null ? null : price.toFixed(axis.decimals);
      if (priceText) {
        record(`T,${now},${priceText},${axis.pip}`); // registro del precio real
        const lastQuote = track[track.length - 1];
        if (!lastQuote || now - lastQuote.time >= TRACK_STEP_MS) track.push({ time: now, value: price });
        while (track.length && now - track[0].time > trackMemoryMs()) track.shift();
      }

      // Se puede medir el precio si hay cotizacion real, o si las velas se leen bien (para medirlo
      // respecto a ellas). Solo si no hay ninguna de las dos se espera a que se destape.
      const clean = priceY !== null && (quote !== null || formingOk);
      coverReason = clean ? null : check.reason;

      // Velas para el analisis: las de esta lectura si son de fiar; si algo las tapa, las ultimas
      // buenas (el precio se sigue midiendo en vivo de todas formas).
      if (formingOk) goodCandles = { time: now, candles };
      const usable = formingOk || !goodCandles || now - goodCandles.time > GOOD_CANDLES_MS ? candles : goodCandles.candles;

      if (formingOk) {
        const hist = history.update(candles, priceY, now, trackMemoryMs());
        // Memoria del mercado: se guarda cada vela que acaba de cerrar y se consulta que paso
        // las otras veces que la grafica estuvo en una situacion como la de ahora.
        if (marketMemory) {
          if (hist.added.length) {
            const ranges = hist.candles.slice(-20).map((c) => c.high - c.low).sort((a, b) => a - b);
            const unit = ranges[Math.floor((ranges.length - 1) / 2)] || 1;
            const seconds = marketMemory.stats(hist.candles).candleSeconds;
            const step = (seconds || 15) * 1000;
            // Tramos de la vela que acaba de cerrar: hacia donde fue el precio en cada uno. Solo si se
            // vio la vela entera (se sabe cuando empezo) y cerro una sola.
            let segments = '';
            if (seconds && hist.added.length === 1 && candleStartedAt && Math.abs(now - candleStartedAt - step) < step * 0.35) {
              const path = quote ? track.slice(-400).map((p) => ({ time: p.time, value: p.value / quote.perPixel })) : hist.prices;
              segments = segmentsOf(path, candleStartedAt, now, segmentCount(seconds, config.cycleSeconds));
            }
            hist.added.forEach((candle, i) =>
              marketMemory.add(candle, now - (hist.added.length - 1 - i) * step, unit, i === hist.added.length - 1 ? segments : ''),
            );
            candleStartedAt = now; // acaba de cerrar una vela: empieza la siguiente
          }
          // Se consulta en cada lectura: lo que dice la memoria depende tambien del momento de la vela.
          memoryInfo = marketMemory.stats(hist.candles, candleClock(now, forming));
        }
        // Recorrido del precio para "Mov. 1 min" y el patron: la cotizacion real si esta a la
        // vista (en pixeles de la escala actual); si no, el recorrido respecto a las velas.
        // (Para las lecturas basta el ultimo minuto y medio; el patron medido usa todo lo recordado.)
        const prices = quote ? track.slice(-400).map((p) => ({ time: p.time, value: p.value / quote.perPixel })) : hist.prices;
        // Patron medido: si a este plazo el precio viene continuando o rebotando.
        if (now - regimeAt >= REGIME_EVERY_MS) {
          regimeAt = now;
          regime = measureRegime(quote ? track : hist.prices, config.cycleSeconds * 1000, now);
        }
        panel = computeReadings({
          candles: hist.candles,
          forming,
          prices,
          now: tickMomentum(last.ticks || [], now),
          time: now,
          asset: config.asset,
          pips: axis ? { perPixel: axis.perPixel, pip: axis.pip } : null,
          trendCandles: longTrade() ? 20 : 12,
        });
        longCandles = forming && hist.candles.length ? [...hist.candles, forming] : candles;
      }
      const advice = councilAdvice(now);
      last = byTime.update({
        candles: usable,
        priceY,
        now,
        clean,
        quote,
        formingOk,
        context: panelContext(),
        regime,
        memory: memoryVote(),
        entryMs: entryMs(),
        cycleMs: config.cycleSeconds * 1000,
        // Senal al instante (solo con boton): sin pausa de analisis y sin esperar a la IA.
        pauseMs: instantMode() ? 0 : config.pauseSeconds * 1000,
        payout: config.payout,
        advice,
        force: config.alwaysSignal,
        manual: config.manual,
        waitForAdvice: anyAi() && anyAiBusy() && !instantMode(),
      });
      // Comparacion: la misma pulsacion, pero con la senal de las reglas dada AL INSTANTE
      // (sin esperar a la IA). No se muestra como senal; solo se mide, para saber que conviene.
      if (config.manual) {
        const shadowResult = shadow.update({
          candles: usable,
          priceY,
          now,
          clean,
          quote,
          formingOk,
          context: panelContext(),
        regime,
        memory: memoryVote(),
          entryMs: entryMs(),
          cycleMs: config.cycleSeconds * 1000,
          pauseMs: 0,
          payout: config.payout,
          force: config.alwaysSignal,
          manual: true,
        });
        instantScore = shadowResult.live;
      }
      // Precio de entrada de la senal en curso: el del momento en que el usuario entra (la senal
      // mas su retraso de entrada). Sirve para dibujar la linea de entrada y decir, en vivo,
      // cuantos pips va a favor o en contra.
      // Al salir la senal se anota el precio de ese instante: ahi va la linea de COMPRA / VENTA sugerida.
      if (last.phase === 'signal' && previousPhase !== 'signal') entry = { at: now, signalPrice: price, signalRow: priceY, price: null, taken: false };
      if (last.phase !== 'signal') entry = null;
      if (entry && !entry.taken && now - entry.at >= entryMs() && price !== null) {
        entry.price = price;
        entry.taken = true;
      }

      // Lo que el escaner dibuja sobre la grafica (en puntos de pantalla, relativos a la zona).
      {
        // De pixeles de la imagen a puntos de pantalla dentro de la zona: punto = margen + pixel / escala.
        const k = shot.scale;
        const o = CROP_INSET;
        // La vela actual se sigue con la lectura de ESTE instante siempre que la linea del precio
        // pase por su cierre (eso solo le pasa a la vela en curso de verdad). No espera a que las
        // velas cerradas esten verificadas: si no, el marcador se quedaba atras en cada cierre.
        const liveCurrent = priceY !== null && check.forming && candles.length >= 3;
        const current = (liveCurrent ? candles[candles.length - 1] : usable[usable.length - 1]) || null;
        const inPips = (px) => (axis ? Math.round((10 * Math.abs(px) * axis.perPixel) / axis.pip) / 10 : null);
        const top = current ? Math.max(current.open, current.close) : 0;
        const bottom = current ? Math.min(current.open, current.close) : 0;
        const dirSign = last.signal && last.signal.dir === 'down' ? -1 : 1;
        const seconds = memoryInfo && memoryInfo.candleSeconds ? memoryInfo.candleSeconds : 0;
        scanInfo = {
          mode: last.phase === 'signal' ? 'signal' : 'analysis',
          verified,
          rate: readsPerSecond(now), // lecturas de pantalla por segundo en este momento
          candles: usable.map((c) => ({ x: o + c.x0 / k, w: (c.x1 - c.x0 + 1) / k, y: o - c.high / k, h: (c.high - c.low) / k, up: c.dir === 'up' })),
          support: panel && panel.rows.support !== null ? o + panel.rows.support / k : null,
          resistance: panel && panel.rows.resistance !== null ? o + panel.rows.resistance / k : null,
          saved: memoryInfo ? memoryInfo.total : 0, // velas guardadas en la memoria del mercado
          // La vela actual, al detalle: cuerpo, mechas, apertura y precio.
          current: current
            ? {
                x: o + current.x0 / k,
                w: (current.x1 - current.x0 + 1) / k,
                bodyTop: o - top / k,
                bodyBottom: o + (1 - bottom) / k, // la fila del borde de abajo, incluida
                high: o - current.high / k,
                low: o + (1 - current.low) / k,
                open: o - current.open / k,
                price: o + (priceY === null ? -current.close : priceY) / k,
                up: current.dir === 'up',
                covered: !liveCurrent, // algo la tapa: se muestra la ultima lectura buena
                bodyPips: inPips(top - bottom),
                upperPips: inPips(current.high - top),
                lowerPips: inPips(bottom - current.low),
                pattern: last.readings ? last.readings.candle.text : '',
                figure: last.formation ? last.formation.name : '', // figura de varias velas detectada
                moving: last.readings ? last.readings.price.text : '',
                lean: last.readings ? last.readings.price.lean : 'flat',
                quote: priceText,
                elapsed: candleStartedAt ? Math.round((now - candleStartedAt) / 100) / 10 : null, // segundos que lleva esta vela
                seconds, // cuanto dura cada vela (0 = aun no se sabe)
              }
            : null,
          // Senal en curso: linea en el precio de entrada y como va en este instante.
          // Linea de COMPRA / VENTA sugerida: aparece en cuanto sale la senal, en el precio de ese
          // instante. Cuando llega el momento de entrada del usuario se pasa a ese precio y
          // empieza a decir cuantos pips va ganando o perdiendo.
          entry: (() => {
            if (!entry || !last.signal || !last.signal.dir) return null;
            const base = entry.taken ? entry.price : entry.signalPrice;
            const withQuote = base !== null && Boolean(axis) && axis.anchored && price !== null;
            // Sin el eje a la vista no hay cotizacion: la linea se queda en la fila del precio de la senal.
            if (!withQuote && entry.signalRow === null) return null;
            return {
              dir: last.signal.dir,
              confidence: last.signal.confidence,
              taken: entry.taken,
              row: withQuote ? o + axis.rowOf(base) / k : o + entry.signalRow / k,
              quote: withQuote ? base.toFixed(axis.decimals) : null,
              pips: withQuote && entry.taken ? Math.round((10 * dirSign * (price - base)) / axis.pip) / 10 : null, // + ganando, - perdiendo
            };
          })(),
        };
      }

      // Registro: cada senal que se da y como termino.
      if (last.phase === 'signal' && previousPhase !== 'signal' && last.signal) {
        lastSignalAt = now;
        record(`S,${now},${last.signal.dir || 'wait'},${last.signal.source},${last.signal.confidence},${config.cycleSeconds},${regime && regime.kind ? regime.kind : ''}`);
      } else if (previousPhase === 'signal' && last.phase !== 'signal' && last.lastResult) {
        record(`R,${now},${last.lastResult.replace(/,/g, ' ')}`);
        // Justo ahora la plataforma dibuja el globo del resultado: se guardan dos imagenes de la
        // zona para poder revisar despues por que un globo se conto o no.
        autoShots = [now + 600, now + 2200];
      }
      // Marcador de cada IA: al terminar la senal se sabe hacia donde fue el precio de verdad.
      if (previousPhase === 'signal' && last.phase !== 'signal' && council.voted && council.votedDir) {
        const opposite = council.votedDir === 'up' ? 'down' : 'up';
        const actual = last.lastResult === 'acertó' ? council.votedDir : last.lastResult === 'falló' ? opposite : null;
        scoreVotes(council.scores, council.voted, actual);
        rememberOutcome(council.memory, council.votedAnswers, actual);
        council.voted = null;
        council.votedAnswers = null;
      }
      // Empieza una senal: se anota lo que dijo cada IA (para su marcador). Las respuestas ya
      // usadas, o una consulta que no llego a tiempo, dejan de servir.
      if (last.phase === 'signal' && previousPhase !== 'signal') {
        const votes = Object.entries(council.answers).map(([id, answer]) => [id, answer.dir]);
        council.voted = votes.length ? Object.fromEntries(votes) : null;
        council.votedDir = last.signal ? last.signal.dir : null;
        council.votedAnswers = votes.length ? { ...council.answers } : null;
        council.answers = {};
        council.requestId++;
        council.asked = false;
      }
      // A las IA se les pregunta una vez por prediccion, a todas a la vez.
      //  - Automatico: un poco ANTES de que termine la senal en curso, para que tengan esos
      //    segundos mas toda la pausa de analisis.
      //  - Manual: al pulsar PREDECIR (empieza el analisis); la senal sale en cuanto contestan.
      if (anyAi() && !council.asked && !instantMode()) {
        const pauseMs = config.pauseSeconds * 1000;
        const endingSoon = !config.manual && last.phase === 'signal' && last.remainingMs <= AI_LEAD_MS;
        if (endingSoon || last.phase === 'analysis') {
          council.asked = true;
          let windowMs = last.remainingMs;
          if (last.phase === 'signal') windowMs += pauseMs;
          else if (config.manual) windowMs += AI_MANUAL_EXTRA_MS;
          askCouncil(longCandles.length ? longCandles : usable, last.moves || [], last.ticks || [], windowMs, panel ? panel.data : null);
        }
      }
      previousPhase = last.phase;
      updateScanProtection(now);
    } else {
      last = byCandle.update(candles, config.payout);
    }
    publish();
  } catch (err) {
    publish(`Error al escanear: ${err.message}`);
  } finally {
    busy = false;
    // Mientras se escanea se lee la pantalla sin pausas (unas 5 veces por segundo), para que el
    // seguimiento de la vela actual sea lo mas fino posible.
    if (scanningNow() && auto && config.region) setTimeout(scanTick, 15);
  }
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Lector de tendencia',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Los clics atraviesan la ventana salvo cuando el raton esta sobre el panel.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// ---------- Mensajes desde el panel ----------
ipcMain.on('ready', () => publish());

ipcMain.on('set-ignore', (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

ipcMain.on('set-region', (_e, rect) => {
  config.region = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  saveConfig();
  resetTrackers(); // otra zona = otra medicion
  history.reset(); // y otro historial de velas
  quality.reset();
  stability.reset();
  scanInfo = null;
  regime = null;
  regimeAt = 0;
  axis = null;
  priceText = null;
  track = [];
  goodCandles = null;
  longCandles = [];
  panel = null;
  publish();
});

ipcMain.on('toggle-auto', () => {
  auto = !auto;
  publish();
});

ipcMain.on('set-payout', (_e, value) => {
  const payout = Number(value);
  if (!Number.isFinite(payout) || payout < 1 || payout > 300) return;
  config.payout = payout;
  saveConfig();
  last = { ...last, live: summarize(last.live, payout) };
  publish();
});

// Segundos entre senales (0 = una senal por vela). Cambiar de modo reinicia el marcador:
// las senales de un modo no son comparables con las del otro.
ipcMain.on('set-cycle', (_e, value) => {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return;
  if (seconds === config.cycleSeconds) return;
  config.cycleSeconds = seconds;
  saveConfig();
  resetTrackers();
  publish('Cambió el tiempo: marcador en cero');
});

// Segundos de analisis entre senales (0 = sin pausa). No cambia lo ya medido.
ipcMain.on('set-pause', (_e, value) => {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) return;
  config.pauseSeconds = seconds;
  saveConfig();
  publish();
});

// Boton PREDECIR (modo manual): arranca un analisis y luego da la senal.
ipcMain.on('predict', () => {
  if (config.cycleSeconds > 0 && byTime.predict()) {
    council.answers = {};
    council.requestId++; // descarta cualquier respuesta vieja de las IA
    council.asked = false;
    shadow.predict(); // la misma pulsacion, medida con la senal al instante
    scanUntil = Date.now() + 900; // el escaner se ve aunque la senal salga al instante
    protectForScan(true);
    scanTick(); // se lee la pantalla ya, sin esperar al siguiente ciclo de 300 ms
  }
});

// Senal al instante al pulsar PREDECIR: sin pausa de analisis ni espera a la IA.
ipcMain.on('set-instant', (_e, value) => {
  config.instant = Boolean(value);
  saveConfig();
  publish();
});

// Manual (true): se predice al pulsar el boton. Automatico (false): una senal tras otra.
ipcMain.on('set-manual', (_e, value) => {
  config.manual = Boolean(value);
  saveConfig();
  publish();
});

// Nombre del activo, solo como contexto para la IA.
ipcMain.on('set-asset', (_e, value) => {
  config.asset = String(value || '').trim().slice(0, 60);
  saveConfig();
  // Cada activo tiene su propia memoria del mercado.
  if (marketMemory) {
    marketMemory.setAsset(config.asset);
    memoryInfo = null;
  }
  publish();
});

// Dar siempre ARRIBA o ABAJO (true) o permitir ESPERAR cuando no hay lectura clara (false).
ipcMain.on('set-always', (_e, value) => {
  config.alwaysSignal = Boolean(value);
  saveConfig();
  publish();
});

// ---------- IA: claves de ChatGPT (openai), Gemini y Claude ----------
// `provider` llega del panel; solo se aceptan los tres conocidos (por defecto, openai).
const providerId = (value) => (PROVIDER_ORDER.includes(value) ? value : 'openai');

ipcMain.on('ai-set-key', async (_e, value, provider) => {
  const id = providerId(provider);
  const ai = ais[id];
  const company = PROVIDERS[id].company;
  const key = String(value || '').trim();
  if (key.length < 20 || /\s/.test(key)) {
    ai.status = `Eso no parece una clave de ${company}.`;
    return publish();
  }
  ai.status = `Comprobando la clave con ${company}…`;
  publish();
  try {
    await activateAi(id, key);
    if (!(await storeAiKey(id, key))) ai.status += ' (no se pudo guardar cifrada: habrá que pegarla otra vez al abrir)';
  } catch (err) {
    ai.key = null;
    ai.status = `No se activó la IA: ${err.message}`;
  }
  publish();
});

// Cambiar de modelo: solo entre los que la cuenta tiene.
ipcMain.on('ai-set-model', (_e, model, provider) => {
  const id = providerId(provider);
  const ai = ais[id];
  if (!ai.key || !ai.models.includes(model)) return;
  ai.model = model;
  delete council.answers[id];
  config[PROVIDERS[id].configKey] = model;
  saveConfig();
  ai.status = `IA activa · modelo ${model}`;
  publish();
});

ipcMain.on('ai-clear', (_e, provider) => {
  const id = providerId(provider);
  const ai = ais[id];
  ai.key = null;
  ai.model = null;
  ai.models = [];
  delete council.answers[id];
  council.requestId++; // descarta cualquier respuesta en camino
  try {
    fs.unlinkSync(keyFile(id));
  } catch {
    /* no habia archivo */
  }
  ai.status = anyAi() ? 'Clave borrada.' : 'Clave borrada: el panel usa sus propias reglas.';
  publish();
});

// Abre en el navegador la pagina donde se crean las claves de ese proveedor (solo esa direccion).
ipcMain.on('ai-open-keys-page', (_e, provider) => shell.openExternal(PROVIDERS[providerId(provider)].keysPage));

ipcMain.on('reset', () => {
  resetTrackers();
  publish('Marcador en cero');
});

// Diagnostico: guarda la imagen de la zona y lo leido en "capturas".
ipcMain.on('save-debug', async () => {
  try {
    if (!config.region) return publish('Primero marca la zona de la gráfica');
    const dir = path.join(__dirname, 'capturas');
    fs.mkdirSync(dir, { recursive: true });
    const shot = await captureScreen();
    const image = cropRegion(shot, config.region);
    const pixels = toPixels(image);
    const reading = {
      candles: readCandles(pixels.data, pixels.width, pixels.height),
    };
    reading.priceLineY = findPriceLine(pixels.data, pixels.width, pixels.height, closeRow(reading.candles));
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    fs.writeFileSync(path.join(dir, `${stamp}_grafica.png`), image.toPNG());
    fs.writeFileSync(path.join(dir, `${stamp}_lectura.json`), JSON.stringify(reading, null, 1), 'utf8');
    publish('Captura guardada en la carpeta "capturas"');
  } catch (err) {
    publish(`No se pudo guardar la captura: ${err.message}`);
  }
});

ipcMain.on('quit', () => app.quit());

// ---------- Arranque ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadConfig();
    createWindow();
    setInterval(scanTick, SCAN_INTERVAL_MS);
    setInterval(flushRecord, 5000);
    app.on('before-quit', flushRecord);
    record(`V,${Date.now()},${BUILD}`); // desde aqui, lo que se registre es de esta version
    marketMemory = createMarketMemory(path.join(app.getPath('userData'), 'memoria'));
    marketMemory.setAsset(config.asset);
    setInterval(() => marketMemory.flush(), 5000);
    app.on('before-quit', () => marketMemory.flush());
    // Las claves guardadas se reactivan en segundo plano, cada una por su lado.
    for (const id of PROVIDER_ORDER) {
      loadAiKey(id).then((savedKey) => {
        if (!savedKey) return;
        ais[id].status = 'Comprobando la clave guardada…';
        publish();
        activateAi(id, savedKey)
          .catch((err) => {
            ais[id].status = `No se activó la IA: ${err.message}`;
          })
          .finally(() => publish());
      });
    }
  });
  app.on('window-all-closed', () => app.quit());
}
