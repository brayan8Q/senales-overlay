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
const { summarize, patternStats, breakEvenOf, PATTERN_VETO_MIN } = require('./src/score');
const { candleSeen, candleChange, askMoment } = require('./src/lastcandle');
const { findResultBadges, viewJumped, createBadgeCounter } = require('./src/badges');
const { MIN_CANDLES } = require('./src/signal');
const { describeChart } = require('./src/ai');
const { PROVIDERS } = require('./src/providers');
const { combine, nickname, scoreVotes, rememberOutcome, feedbackFor, PROVIDER_ORDER } = require('./src/council');
const { niveles, VENTANA: LEVEL_CANDLES } = require('./src/levels');
const { createCandleClock } = require('./src/candleclock');
const { PATTERNS, PATTERN_KEYS } = require('./src/formations');
const { createFeed, assetKey, PERIODS: FEED_PERIODS } = require('./src/feed');
const { fitPriceMap, toScreen } = require('./src/pricemap');
const { countOrderMark, MARK_MIN } = require('./src/ordermark');
const { createBotBridge } = require('./src/botbridge');

// PREDECIR con la vela ya avanzada: true = esperar a que abra la vela siguiente y analizar ahi;
// false = analizar y predecir al momento de pulsar. El usuario pidio quitar la espera (13 nov 2026).
// En los dos casos la senal vale hasta el cierre de la vela en curso cuando sale.
const WAIT_FOR_NEXT_CANDLE = false;
// Martingala (15 nov 2026): cuantas seguidas como mucho se pueden configurar, y cuanto se espera
// a las IA para analizarla (es una prediccion nueva, no una entrada a ciegas).
const MARTIN_MAX_LEVELS = 6;
const MARTIN_THINK_MS = 2500;
// Plazos largos (1 minuto o mas, p. ej. 5 min con velas de 1 min): la senal dura EXACTAMENTE los
// segundos puestos en "Cada senal vale", contados desde que sale, igual que el temporizador de la
// plataforma. Por debajo de eso (operaciones de segundos) vale hasta el cierre de la vela en curso.
const LONG_SIGNAL_SECONDS = 60;
// Desde el 13 nov (tarde) el usuario opera a segundos exactos (3 s): la senal dura lo que diga
// "Cada senal vale", contado desde que sale, tambien en plazos cortos. Calificar al cierre de la
// vela queda como opcion (config.untilClose = true en config.json), apagada por defecto.
const closeMode = () => Boolean(config.untilClose) && config.manual && config.cycleSeconds < LONG_SIGNAL_SECONDS;
const FEW_CANDLES = 8; // con menos velas a la vista se avisa (sigue funcionando)
const MISSING_READS_TO_WARN = 2; // lecturas seguidas sin ver la vela en curso antes de avisar (el marcador se oculta desde la primera)
const SCAN_INTERVAL_MS = 300; // cada cuanto se lee la pantalla (velas y linea de precio)
const AI_MIN_PAUSE_SECONDS = 3; // la IA necesita al menos este tiempo para contestar
const AI_LEAD_MS = 2500; // modo automatico: la consulta sale este tiempo antes de que termine la senal
const AI_MANUAL_EXTRA_MS = 5000; // modo manual: cuanto mas se espera a la IA pasada la pausa
// PREGUNTA TARDE (15 nov 2026, tarde; ver src/lastcandle.js): con la senal saliendo al abrir la
// vela, a las IA no se les pregunta al empezar el analisis (segundo 10 de 15: no veian el ultimo
// tercio de la vela) sino cuando a la vela le falta esto. Ven el 80 % y siguen contestando a
// tiempo: ese dia, 187 de 188 consultas a gpt-4.1-mini tardaron menos de 2.6 s.
// (15 nov 18:35, en vivo: preguntando a 3 s del cierre la IA solo contesto 2 de 12 consultas y las
// senales salieron por reglas. Vuelve a 6 s -al empezar el analisis, como cuando si contestaba-
// hasta ver en el registro (E,ia-fallo / E,ia-tarde) por que. La confirmacion con la vela cerrada cubre el resto.)
// (18:50: la causa no era el tiempo sino un plazo con decimales, ya corregido. Se pregunta a 3.5 s
// del cierre -segundo 11.5 de 15-: la IA contesta en 1 a 2 s.)
const AI_ASK_BEFORE_CLOSE_MS = 3500;
const AI_ANSWER_GRACE_MS = 400; // askCouncil descuenta esto de la ventana: asi el plazo llega hasta que sale la senal
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
  patternVeto: true, // vetar los patrones con mala estadistica (20+ operaciones bajo su punto de equilibrio)
  antiRebound: true, // no dar senal a favor de una vertical recien hecha (ver src/rebound.js)
  internalSource: true, // precios y velas de los datos internos de la terminal demo (ver src/feed.js)
  martinLevels: 4, // seguimiento: martingalas seguidas cuando una senal pierde (0 = sin seguimiento)
  // Dos etapas: segundos que se espera a que el usuario ponga su operacion; el plazo de la senal
  // cuenta desde que entra (0 = cuenta desde que sale la senal, como antes).
  entryWaitSeconds: 5,
  // Bot en DEMO: si el puente del bot de Pocket esta abierto (trader\pocket_tyl\lector.py), cada
  // senal y su martingala las abre el bot en la cuenta DEMO; el panel cuenta desde esa entrada.
  autoTrade: true,
  // La prediccion sale siempre al abrir una vela nueva (se analiza al final de la vela en curso).
  newCandle: true,
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
// Soporte y resistencia (ver src/levels.js): historial propio de 80 velas cerradas, para no
// cambiar con cuantas velas se calculan las demas lecturas. Lo que aqui se guarda es lo que se
// dibuja sobre la grafica y, tal cual, lo que se manda a las IA.
const levelHistory = createHistory({ maxCandles: LEVEL_CANDLES });
let levels = null; // { estado, soporte, resistencia, tipica } de la ultima lectura buena
// Reloj de la vela en curso (ver src/candleclock.js): cuanto lleva y cuanto le falta.
const liveClock = createCandleClock();
let clockInfo = null;
let missingReads = 0; // lecturas seguidas en las que la vela en curso no esta a la vista
let candleSerial = 0; // numero de la vela en curso cuando se lee por pixeles (crece con cada cierre)
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
// Con el boton PREDECIR la senal vale hasta el cierre de la vela y se mide contra el precio del
// momento de la senal: ahi el retraso de entrada no interviene.
const entryMs = () => (config.manual ? 0 : Math.max(0, Math.min(ENTRY_MAX_MS, config.entryDelayMs || 0)));
// Escaner sobre la grafica: mientras se ve, la ventana se oculta a las capturas de pantalla para
// que el haz no se cuele en la lectura de las velas.
let scanUntil = 0;
let scanProtected = false;
let scanEndedAt = 0;
// Se escanea durante el analisis y durante la senal (ahi se sigue la vela actual y la entrada).
// Mientras se espera a que abra la vela siguiente no hay haz: todavia no se analiza nada.
const scanningNow = () =>
  config.cycleSeconds > 0 && (last.phase === 'analysis' || last.phase === 'signal' || (Date.now() < scanUntil && last.phase !== 'waiting'));
// El marcador de la vela actual y los niveles se dibujan SIEMPRE que el panel esta leyendo (no
// solo al analizar). Mientras haya algo dibujado sobre la grafica, la ventana se oculta a las
// capturas de pantalla: si no, el panel leeria sus propios trazos como si fueran velas.
const followingNow = () => config.cycleSeconds > 0 && auto && Boolean(config.region);
let entry = null; // senal en curso: { at, price, taken }
let candleStartedAt = 0; // cuando empezo la vela en curso
function protectForScan(on) {
  if (win && !win.isDestroyed()) win.setContentProtection(on);
  scanProtected = on;
}
function updateScanProtection(now) {
  if (scanningNow() || followingNow()) {
    scanEndedAt = 0;
    if (!scanProtected) protectForScan(true);
  } else if (scanProtected) {
    // Se espera a que el panel haya quitado el haz antes de volver a ser visible a las capturas.
    if (!scanEndedAt) scanEndedAt = now;
    else if (now - scanEndedAt >= 700) protectForScan(false);
  }
}
// ---------- Porcentaje de confianza: acierto MEDIDO por nivel ----------
// El panel califica cada senal como confianza alta, media o baja. Esa palabra no es un
// porcentaje: el porcentaje que se muestra es cuantas senales de ese mismo nivel acertaron de
// verdad (segun el registro de los ultimos dias y lo que se va midiendo). No es una promesa.
const CONFIDENCE_DAYS = 7; // dias de registro que cuentan
const confidenceStats = {}; // { alta: { wins, losses }, media: {...}, baja: {...} }
let openSignal = null; // senal en curso: { dir, confidence }
function countConfidence(level, result) {
  if (!level || level === 'ninguna') return;
  const hit = /^acert/.test(result);
  if (!hit && !/^fall/.test(result)) return; // empates y "sin medir" no cuentan
  const cell = (confidenceStats[level] = confidenceStats[level] || { wins: 0, losses: 0 });
  if (hit) cell.wins++;
  else cell.losses++;
}
/** Al abrir: lee del registro las senales ya calificadas (S seguida de su R). */
function loadConfidenceStats() {
  for (const level of Object.keys(confidenceStats)) delete confidenceStats[level];
  try {
    const dir = path.join(app.getPath('userData'), 'registro');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().slice(-CONFIDENCE_DAYS);
    for (const file of files) {
      let signal = null;
      for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
        const cols = line.split(',');
        if (cols[0] === 'S') signal = cols;
        else if (cols[0] === 'R' && signal) {
          // Solo las senales del MISMO plazo que el de ahora: una de 5 segundos no dice nada de una de 5 minutos.
          if (signal[2] !== 'wait' && Number(signal[5]) === config.cycleSeconds) countConfidence(signal[4], cols[2] || '');
          signal = null;
        }
      }
    }
  } catch {
    /* sin registro todavia */
  }
}
/** Acierto medido del nivel de confianza de una senal: { level, wins, total, rate } (rate null sin datos). */
function confidenceOf(signal) {
  if (!signal || !signal.dir || !signal.confidence) return null;
  const cell = confidenceStats[signal.confidence] || { wins: 0, losses: 0 };
  const total = cell.wins + cell.losses;
  return { level: signal.confidence, wins: cell.wins, total, rate: total ? Math.round((100 * cell.wins) / total) : null };
}

// ---------- Estadistica por PATRON y vetos (15 nov 2026) ----------
// Cada senal medida se guarda con el patron que la disparo, el pago de ese momento y su
// resultado (linea "P" del registro). De ahi sale, por patron, el acierto y el P&L de las
// ultimas 100 operaciones (src/score.js), que el panel muestra junto a la senal. Un patron con
// 20+ operaciones y acierto por debajo de su punto de equilibrio queda vetado (si el veto esta
// encendido): sus senales salen como ESPERAR y se siguen midiendo en papel.
//   P,ms,patron,lado,resultado,pago,fuente del pago,segundos,tipo
//   tipo: op = senal mostrada · veto-patron / veto-rebote / veto-vela = senal vetada, medida en papel
const PATTERN_DAYS = 30; // dias de registro que se leen al abrir
let patternOps = []; // operaciones que cuentan para la estadistica: { pattern, result, payout }
let patternTable = {}; // patternStats(patternOps)
// Senales vetadas por anti-rebote y medidas en papel: cuantas habrian ganado o perdido.
let reboundTally = { wins: 0, losses: 0, ties: 0 };
// Martingalas de seguimiento ya medidas (se cuentan aparte: no son senales del analisis).
let martinTally = { wins: 0, losses: 0, ties: 0 };
// Senales frenadas por la confirmacion con la vela cerrada (la vela cambio de color despues de que
// la IA la miro), medidas en papel: cuantas habrian ganado o perdido. No cuentan para los patrones.
let candleTally = { wins: 0, losses: 0, ties: 0 };
const tallyKey = (key) => (key === 'win' ? 'wins' : key === 'loss' ? 'losses' : 'ties');
const resultKey = (text) => (/^acert/.test(text) ? 'win' : /^fall/.test(text) ? 'loss' : /^empate/.test(text) ? 'tie' : null);
// Pago que muestra la terminal demo para el par (fuente interna): { value, at, symbol }.
let visorPayout = null;
let botPaid = null; // pago de la ultima operacion que abrio el bot: { value, at }
const BOT_PAID_MS = 180000; // cuanto vale ese pago como «pago de ahora»
// Con el bot, la orden sale este tiempo antes de que abra la vela: el bot la detiene hasta el segundo
// entero (su LATE = 0.80), asi la operacion abre al empezar la vela y no 0.6 a 1 s despues.
const OPEN_LEAD_MS = 150;
let levelMemo = null; // precio real del soporte y la resistencia dibujados (para que no brinquen)
let internalSeenAt = 0; // ultima vez que la fuente interna cuadro con la grafica de la pantalla
/** Pago de este momento: el de la fuente interna si se conoce y es del mismo par; si no, el escrito en el panel. */
function payoutNow() {
  const now = Date.now();
  // PAGO REAL (15 nov 2026, noche): lo que de verdad pago Pocket en la ultima operacion del bot, si es
  // reciente. (Ese dia la cuenta bajo a 76 % mientras la terminal demo seguia diciendo 92 %.)
  if (botPaid && config.autoTrade && bot.status().online && now - botPaid.at <= BOT_PAID_MS && botPaid.value > 0) return { value: botPaid.value, source: 'bot' };
  const fresh = visorPayout && now - visorPayout.at <= 15000;
  // Solo si la fuente interna cuadro con la grafica de la pantalla hace poco: si en la pantalla
  // hay otro par, el pago de la terminal demo es de otro activo y no se usa.
  const confirmed = internalSeenAt && now - internalSeenAt <= 60000;
  const same = fresh && confirmed && (!config.asset || assetKey(visorPayout.symbol) === assetKey(config.asset));
  return same ? { value: visorPayout.value, source: 'interna' } : { value: config.payout, source: 'config' };
}
/** Anota una operacion medida (mostrada o vetada) y actualiza la estadistica. */
function addPatternOp(now, { pattern, dir, result, kind, paid = null }) {
  const key = resultKey(result || '');
  const pay = paid || payoutNow();
  record(`P,${now},${pattern},${dir},${key || 'sin-medir'},${pay.value},${pay.source},${config.cycleSeconds},${kind}`);
  if (!key) return;
  if (kind === 'veto-rebote') {
    reboundTally[tallyKey(key)]++;
    return;
  }
  if (kind === 'veto-vela') {
    candleTally[tallyKey(key)]++;
    return;
  }
  if (/^martin/.test(kind)) {
    martinTally[tallyKey(key)]++;
    return;
  }
  patternOps.push({ pattern, result: key, payout: pay.value });
  if (patternOps.length > 5000) patternOps = patternOps.slice(-4000);
  patternTable = patternStats(patternOps);
}
/** Al abrir (o al cambiar de plazo): lee del registro las operaciones ya medidas de este mismo plazo. */
function loadPatternStats() {
  patternOps = [];
  reboundTally = { wins: 0, losses: 0, ties: 0 };
  martinTally = { wins: 0, losses: 0, ties: 0 };
  candleTally = { wins: 0, losses: 0, ties: 0 };
  try {
    const dir = path.join(app.getPath('userData'), 'registro');
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().slice(-PATTERN_DAYS);
    for (const file of files) {
      for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
        if (!line.startsWith('P,')) continue;
        const [, , pattern, , result, payout, , seconds, kind] = line.split(',');
        if (Number(seconds) !== config.cycleSeconds || !['win', 'loss', 'tie'].includes(result)) continue;
        if (kind === 'veto-rebote') reboundTally[tallyKey(result)]++;
        else if (kind === 'veto-vela') candleTally[tallyKey(result)]++;
        else if (/^martin/.test(kind || '')) martinTally[tallyKey(result)]++;
        else patternOps.push({ pattern, result, payout: Number(payout) });
      }
    }
  } catch {
    /* sin registro todavia */
  }
  patternTable = patternStats(patternOps);
}
/** Patrones desactivados ahora: { clave: motivo }, o null (ninguno, o el veto esta apagado). */
/**
 * Un patron queda desactivado si lleva 20+ operaciones decididas y su acierto no alcanza el punto
 * de equilibrio con el pago DE AHORA. (15 nov, en vivo: con el pago promedio de sus operaciones
 * pasadas se veto «rango», el mejor patron (54 %), porque en la manana el pago era de 52 %; con el
 * pago de ese momento, 92 %, le bastaba 52.1 %. Lo que importa para decidir hoy es lo que paga hoy.)
 */
function patternOff(stat) {
  if (!stat || stat.accuracy === null || stat.decided < PATTERN_VETO_MIN) return null;
  const need = Math.round(breakEvenOf(payoutNow().value) * 1000) / 10;
  return stat.accuracy < need ? need : null;
}
function vetoedPatterns() {
  if (!config.patternVeto) return null;
  const out = {};
  for (const stat of Object.values(patternTable)) {
    const need = patternOff(stat);
    if (need !== null) out[stat.pattern] = `acierta ${stat.accuracy} % en ${stat.decided} operaciones y con el pago de ahora necesita ${need} %`;
  }
  return Object.keys(out).length ? out : null;
}
/** Patron de la senal en curso con su estadistica, para el panel (null si no hay senal con lado ni veto). */
function patternInfo(signal) {
  if (!signal || !signal.pattern || (!signal.dir && !signal.veto)) return null;
  const key = signal.pattern.key;
  const stat = patternTable[key] || null;
  return {
    key,
    text: PATTERNS[key] || key,
    detail: signal.pattern.detail || '',
    n: stat ? stat.n : 0,
    decided: stat ? stat.decided : 0,
    accuracy: stat ? stat.accuracy : null,
    pnl: stat ? stat.pnl : 0,
    breakEven: stat ? stat.breakEven : null,
    avgPayout: stat ? stat.avgPayout : null,
    vetoed: Boolean(config.patternVeto && patternOff(stat) !== null),
  };
}

// ---------- FUENTE INTERNA de precios y velas (15 nov 2026) ----------
// Una ventana aparte (oculta) abre la terminal DEMO publica de Pocket Option, sin iniciar sesion.
// De ahi solo se ESCUCHA lo que la pagina recibe por su conexion (src/feed.js): precios dos veces
// por segundo, con su hora exacta, y el historial de velas. No se manda nada ni se toca cuenta alguna.
// Los numeros (velas, precio, reloj de la vela) salen de ahi; la pantalla se sigue leyendo para
// saber DONDE dibujar y para comprobar que las dos graficas son la misma (src/pricemap.js). Si la
// fuente interna falla, lleva mas de 5 s sin datos, o no cuadra con la grafica, el panel vuelve
// solo a la lectura por pixeles.
const VISOR_URL = 'https://pocketoption.com/en/cabinet/try-demo/';
const FEED_MISSES_TO_DROP = 4; // lecturas seguidas sin cuadrar antes de soltar la fuente interna
const feed = createFeed();
let visor = null; // ventana con la terminal demo
let visorError = '';
let quitting = false;
let feedMap = null; // recta precio -> pantalla y geometria de las velas: { A, B, at, shift, pitch, geometry }
let feedPeriod = 0; // duracion (s) de las velas de la grafica, confirmada por el ajuste
let feedMisses = 0;
// La fuente interna no se suelta por un momento sin cuadrar (la marca y el sombreado de una operacion
// recien abierta deforman la grafica unos segundos): solo si lleva este tiempo seguido sin cuadrar.
const FEED_DROP_AFTER_MS = 12000;
let feedMissSince = 0; // desde cuando no cuadra (0 = cuadra)
let feedLastBucket = null; // hora de la vela en curso de la fuente en la lectura anterior
let blindReads = 0; // lecturas seguidas con la fuente interna activa y la grafica sin verse bien
const BLIND_READS_TO_WARN = 4;
// Indicador de salud: fuente activa, edad del ultimo dato interno y aviso.
let sourceInfo = { active: 'PÍXELES', enabled: false, code: 'apagada', ageMs: null, stale: false, detail: '' };
let sourceLogged = '';
function setSource(active, code, detail, extra = {}) {
  const status = feed.status();
  const ageMs = extra.ageMs !== undefined ? extra.ageMs : status.lastFrameAt ? Date.now() - status.lastFrameAt : null;
  sourceInfo = { active, enabled: Boolean(config.internalSource), code, detail, stale: false, ...extra, ageMs };
  // Registro: F,ms,fuente activa,motivo (solo cuando cambia).
  const key = `${active}|${code}`;
  if (key !== sourceLogged) {
    sourceLogged = key;
    record(`F,${Date.now()},${active},${code},${String(detail).replace(/[,\r\n]+/g, ' ')}`);
  }
}

/**
 * Lo que da la fuente interna en esta lectura, ya en unidades de pantalla, o null si no se puede
 * usar (y entonces todo sale de los pixeles, como siempre).
 * @param {Array} candles  Velas leidas de la pantalla en esta lectura.
 * @param {boolean} pixelsOk  Esa lectura es de fiar (verificada y con la vela en curso a la vista).
 */
function internalView(now, candles, pixelsOk) {
  const off = (code, detail, extra) => {
    setSource('PÍXELES', code, detail, extra);
    feedLastBucket = null;
    return null;
  };
  if (!config.internalSource) return off('apagada', 'fuente interna apagada');
  if (!feed.status().frames) return off('sin-datos', visorError || 'la fuente interna aún no entrega datos', { stale: true });
  const query = (period) => feed.snapshot({ now, period, asset: config.asset });
  const unusable = (snap) => {
    if (!snap.ok) return off(snap.wrongAsset ? 'otro-par' : 'sin-datos', snap.reason, { stale: !snap.wrongAsset });
    if (snap.stale) return off('caida', `la fuente interna lleva ${Math.round(snap.ageMs / 1000)} s sin actualizar`, { stale: true, ageMs: snap.ageMs });
    return undefined;
  };
  // Primero lo que no depende de la pantalla: que la terminal este en el mismo par y con datos frescos.
  {
    const probe = unusable(query(feedPeriod || (memoryInfo && memoryInfo.candleSeconds) || 15));
    if (probe !== undefined) return probe;
  }
  let snap = null;
  let fitted = false;
  if (pixelsOk && candles.length >= 6) {
    // Se compara la pantalla con la fuente. Si aun no se sabe la duracion de las velas, se
    // prueban todas: solo la correcta cuadra.
    const hint = memoryInfo && memoryInfo.candleSeconds ? memoryInfo.candleSeconds : 0;
    const periods = feedPeriod ? [feedPeriod] : [...new Set([hint, ...FEED_PERIODS].filter(Boolean))];
    let best = null;
    let gross = true; // ninguna duracion se parece siquiera a lo que hay en pantalla
    for (const period of periods) {
      const candidate = query(period);
      const bad = unusable(candidate);
      if (bad !== undefined) return bad;
      const fit = fitPriceMap(candles, candidate);
      if (fit && fit.valid && (!best || fit.rms < best.fit.rms)) best = { fit, snap: candidate };
      // Casi cuadra (error de hasta 3 veces lo tolerado): la grafica es la misma, pero algo la
      // deforma un momento (la linea de la operacion abierta, el globo del resultado).
      if (fit && fit.B > 0 && fit.rms <= fit.tolerance * 3) gross = false;
    }
    if (best) {
      const xs = candles.map((c) => c.x0);
      const steps = xs.slice(1).map((x, i) => x - xs[i]).sort((a, b) => a - b);
      feedPeriod = best.snap.period;
      feedMisses = 0;
      feedMissSince = 0;
      feedMap = {
        A: best.fit.A,
        B: best.fit.B,
        at: now,
        shift: best.fit.shift,
        pitch: steps.length ? steps[Math.floor((steps.length - 1) / 2)] : 0,
        geometry: candles.map((c) => ({ x0: c.x0, x1: c.x1 })).reverse(), // de la vela en curso hacia atras
      };
      snap = best.snap;
      fitted = true;
    } else if (gross || !feedMap) {
      if (!feedMissSince) feedMissSince = now;
      if (++feedMisses >= FEED_MISSES_TO_DROP && (!feedMap || now - feedMissSince >= FEED_DROP_AFTER_MS)) {
        feedMap = null;
        feedPeriod = 0; // se vuelve a buscar la duracion: quiza cambio la temporalidad o el par
      }
    }
    // (Desajuste leve con recta reciente: se sigue con la recta anterior, hasta 30 s.)
  }
  if (!feedMap || now - feedMap.at > GOOD_CANDLES_MS) {
    feedMap = null;
    return off(
      'no-cuadra',
      feedMisses >= FEED_MISSES_TO_DROP
        ? 'la fuente interna no coincide con la gráfica de la pantalla: si cambiaste de par, escríbelo en «Activo» (⚙)'
        : 'la fuente interna espera a ver bien la gráfica para ubicarse',
    );
  }
  if (!snap) {
    snap = query(feedPeriod);
    const bad = unusable(snap);
    if (bad !== undefined) return bad;
  }
  const map = feedMap;
  const shift = fitted ? map.shift : 0;
  const all = [...snap.closed, snap.forming];
  // Velas a la vista: los numeros de la fuente, colocados donde la pantalla dibuja cada vela.
  const visible = [];
  for (let j = Math.min(all.length - 1, map.geometry.length - 1 + shift); j >= 0; j--) {
    const g = j - shift;
    const geometry = g >= 0 ? map.geometry[g] : { x0: map.geometry[0].x0 - g * map.pitch, x1: map.geometry[0].x1 - g * map.pitch };
    visible.push(toScreen(map, all[all.length - 1 - j], geometry));
  }
  if (visible.length < 3) return off('pocas-velas', 'la fuente interna aún tiene pocas velas');
  const closedRows = snap.closed.slice(-LEVEL_CANDLES).map((c) => toScreen(map, c));
  // Velas que cerraron desde la lectura anterior (por la hora de la fuente: exacto).
  let added = [];
  if (feedLastBucket !== null && snap.forming.time > feedLastBucket) {
    const count = Math.round((snap.forming.time - feedLastBucket) / snap.period);
    if (count >= 1 && count <= 3) added = closedRows.slice(-count);
  }
  feedLastBucket = snap.forming.time;
  const decimals = snap.decimals || 5;
  const pip = decimals >= 4 ? 0.0001 : decimals >= 2 ? 0.01 : 10 ** -decimals;
  setSource('INTERNA', 'ok', `${snap.label} · velas de ${snap.period} s`, { ageMs: snap.ageMs });
  internalSeenAt = now;
  return {
    candles: visible,
    closed: closedRows,
    added,
    price: snap.price,
    priceY: -(map.A + map.B * snap.price),
    priceText: snap.price.toFixed(decimals),
    // Empate = mismo precio exacto (con la fuente interna no hay redondeo de pixeles).
    quote: { value: snap.price, perPixel: 1 / map.B, tolerance: 0.5 * 10 ** -decimals },
    // Con la misma forma que el eje leido de la pantalla (src/axis.js), para el resto del panel.
    axis: { internal: true, anchored: true, perPixel: 1 / map.B, pip, decimals, labels: 0, at: (row) => (-row - map.A) / map.B, rowOf: (price) => -(map.A + map.B * price) },
    clock: { known: true, seconds: snap.period, startedAt: snap.clock.startedAt, elapsedMs: snap.clock.elapsedMs, remainingMs: snap.clock.remainingMs, closedNow: added.length > 0, inferred: false },
  };
}

/** Abre (oculta) la ventana con la terminal demo y se pone a escuchar su conexion. */
function createVisor() {
  if (visor || !config.internalSource) return;
  try {
    visor = new BrowserWindow({
      width: 1180,
      height: 760,
      show: false,
      title: 'Fuente interna · terminal demo de Pocket Option',
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:fuente-interna', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    // Cerrarla con la X solo la esconde: sigue dando datos. Se cierra de verdad al salir del panel.
    visor.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      visor.hide();
    });
    visor.on('closed', () => {
      visor = null;
    });
    const contents = visor.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' })); // la terminal no abre mas ventanas
    contents.on('did-fail-load', (_e, _code, description, _url, isMainFrame) => {
      if (isMainFrame) visorError = `la terminal demo no cargó (${description})`;
    });
    contents.on('did-finish-load', () => {
      visorError = '';
    });
    // Se escucha el websocket de la pagina con el depurador integrado (CDP), sin tocar la pagina.
    const sockets = new Set();
    const bug = contents.debugger;
    bug.attach('1.3');
    bug.on('detach', (_e, reason) => {
      visorError = `se soltó la escucha de la terminal demo (${reason})`;
    });
    bug.on('message', (_e, method, params) => {
      if (method === 'Network.webSocketCreated') {
        if (/socket\.io/.test(params.url)) sockets.add(params.requestId);
      } else if (method === 'Network.webSocketClosed') {
        sockets.delete(params.requestId);
      } else if ((method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') && sockets.has(params.requestId)) {
        const frame = params.response;
        // De lo que la pagina MANDA solo se mira a que par cambio la grafica (feed.js); nada se guarda.
        feed.onFrame(frame.payloadData, { binary: frame.opcode === 2, sent: method === 'Network.webSocketFrameSent', now: Date.now() });
      }
    });
    Promise.resolve(bug.sendCommand('Network.enable')).catch((err) => {
      visorError = `no se pudo escuchar la terminal demo: ${err.message}`;
    });
    visor.loadURL(VISOR_URL);
  } catch (err) {
    visorError = `no se pudo abrir la fuente interna: ${err.message}`;
    visor = null;
  }
}
function closeVisor() {
  if (!visor) return;
  const closing = visor;
  visor = null;
  try {
    closing.destroy();
  } catch {
    /* ya estaba cerrada */
  }
  feed.reset();
  feedMap = null;
  feedPeriod = 0;
  visorPayout = null;
}
// La terminal demo recuerda su ultimo par en su propio almacenamiento ("po-td-asset"). Si esta
// en un par distinto del que se opera (campo "Activo" de ajustes), se le deja anotado el correcto
// y se recarga: abre ya en ese par. Como mucho 3 intentos por par, uno cada 20 s.
let visorAssetTry = { key: '', at: 0, count: 0 };
function alignVisorAsset(now) {
  if (!visor || visor.isDestroyed() || !config.asset) return;
  const shown = feed.status().chartAsset;
  const want = assetKey(config.asset);
  if (!shown || assetKey(shown) === want) return;
  const symbol = feed.symbolFor(config.asset);
  if (!symbol) return; // ese par no esta en la terminal (o su lista aun no llega): se elige a mano
  const same = visorAssetTry.key === want;
  if (same && (visorAssetTry.count >= 3 || now - visorAssetTry.at < 20000)) return;
  visorAssetTry = { key: want, at: now, count: same ? visorAssetTry.count + 1 : 1 };
  record(`F,${now},visor,cambio-de-par,${shown} -> ${symbol}`);
  visor.webContents.executeJavaScript(`localStorage.setItem('po-td-asset', ${JSON.stringify(symbol)}); location.reload();`).catch(() => {});
}
/** Cada pocos segundos: el pago y el par que muestra la terminal demo (se leen de su pagina). */
async function readVisorPayout() {
  if (!visor || visor.isDestroyed()) return;
  alignVisorAsset(Date.now());
  try {
    const seen = await visor.webContents.executeJavaScript(
      `(() => { const pay = document.querySelector('.block--payout'); const sym = document.querySelector('.current-symbol'); return { pay: pay ? pay.innerText : '', sym: sym ? sym.innerText : '' }; })()`,
    );
    const match = /(\d{1,3})\s*%/.exec((seen && seen.pay) || '');
    if (match) visorPayout = { value: Number(match[1]), at: Date.now(), symbol: String(seen.sym || '').trim() };
  } catch {
    /* la pagina aun no carga: se intenta en la siguiente */
  }
}

// ---------- Foto real de la pantalla CON el panel ----------
// Mientras el panel lee, su ventana esta oculta a las capturas de pantalla (para no leerse a si
// mismo), asi que ninguna herramienta de capturas lo ve. Para tener una foto de verdad se hace
// aqui: se detiene la lectura un instante, la ventana se deja ver, se captura la pantalla tal
// como esta y se vuelve a ocultar. Queda en la carpeta "capturas" como HHMMSS_pantalla.png.
// Se pide con el boton "Guardar captura" o creando el archivo capturas/pedir_foto.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let photoBusy = false;
async function saveScreenPhoto() {
  if (photoBusy || !win || win.isDestroyed()) return null;
  photoBusy = true;
  const wasProtected = scanProtected;
  try {
    for (let i = 0; i < 60 && busy; i++) await sleep(25); // deja terminar la lectura en curso
    busy = true; // sin lecturas mientras el panel se deja ver
    win.setContentProtection(false);
    await sleep(350);
    const shot = await captureScreen();
    const dir = path.join(__dirname, 'capturas');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}_pantalla.png`);
    fs.writeFileSync(file, shot.image.toPNG());
    return file;
  } catch {
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.setContentProtection(wasProtected);
    await sleep(250); // que vuelva a quedar oculto antes de la siguiente lectura
    busy = false;
    photoBusy = false;
  }
}
// capturas/pedir_foto_senal: la foto se toma sola en cuanto salga la proxima senal con lado
// (para ver la zona de entrada dibujada; una senal dura pocos segundos).
let photoOnSignal = false;
/** Si alguien dejo el archivo capturas/pedir_foto, se toma la foto y se borra la peticion. */
function checkPhotoRequest() {
  const onSignal = path.join(__dirname, 'capturas', 'pedir_foto_senal');
  try {
    if (fs.existsSync(onSignal)) {
      fs.unlinkSync(onSignal);
      photoOnSignal = true;
    }
  } catch {
    /* no es critico */
  }
  const request = path.join(__dirname, 'capturas', 'pedir_foto');
  try {
    if (!fs.existsSync(request)) return;
    fs.unlinkSync(request);
  } catch {
    return;
  }
  saveScreenPhoto();
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
const BUILD = '2026-11-15p pago real del bot · la orden sale 150 ms antes de abrir la vela (entrada pegada a la apertura) · soporte y resistencia firmes · 2026-11-15o sin el reloj exacto de la vela no se predice (ni senal ni martingala a media vela) · 2026-11-15n la IA vuelve a contestar en las senales normales (plazo entero) y se le pregunta en el segundo 11.5 · 2026-11-15m la fuente interna (y con ella el reloj de la vela) ya no se suelta al abrir una operacion: solo tras 12 s sin cuadrar · 2026-11-15l la consulta a la IA vuelve al inicio del analisis (a 3 s del cierre no contestaba) + registro de consultas fallidas · letrero: a media vela solo se espera la vela nueva · 2026-11-15k confirmacion con la vela cerrada (si cambio de color, no entra) · la martingala tambien sale al abrir vela · 2026-11-15j la martingala se analiza (IA y reglas) y sigue hasta 4 seguidas · 2026-11-15i veto por patron segun el pago de ahora · analisis solo en su ventana (senal siempre al abrir la vela) · 2026-11-15h la prediccion sale al abrir cada vela nueva · 2026-11-15g la vela en curso se sigue por su hora (el marcador no se regresa) + numeros arriba del margen · automatico con el bot · 2026-11-15f fusion con el bot de Pocket en DEMO (el bot abre la operacion y da entrada, pago y resultado exactos) · 2026-11-15e la entrada se ve aunque caiga junto al globo de la operacion anterior · 2026-11-15d dos etapas: espera de entrada y plazo contado desde la entrada del usuario (tambien en la martingala) · 2026-11-15c el haz del escaner sigue pasando con la senal abierta · 2026-11-15b seguimiento de la senal con martingala (aviso si va perdiendo, MARTIN al perder) · 2026-11-15a estadistica por patron + auto-veto · veto anti-rebote · fuente interna (terminal demo) con respaldo de pixeles · 2026-11-13k freno para la IA (vela estirada / 4 velas seguidas) · senal por segundos exactos tambien en corto (3 s) · registro de motivos (A/M/C) · sin prediccion se libera en 10 s · plazos largos por segundos exactos (5 min) + % de confianza por plazo · zona de entrada de dos lineas + panel compacto + % de confianza medido · niveles medidos (80 velas) + marcador siempre en la vela actual + PREDECIR al momento (sin espera), vale hasta el cierre de la vela';

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
let shownSignal = null; // la senal en curso (para notar cuando de una se pasa directo a su martingala)
// Entrada del usuario (dos etapas): blancos junto a la vela cuando empezo la espera (ver
// src/ordermark.js). Si suben lo que mide una marca, es que puso su operacion.
let entryBase = 0;
let entryHits = 0; // lecturas seguidas con la marca a la vista (se piden dos para darla por buena)
let entryBadges = 0; // globos de resultado a la vista en la lectura anterior
let entryWasWaiting = false;
let entryStageLogged = false;
let entryStageAt = 0;

// ---------- BOT EN DEMO (15 nov 2026): fusion con el bot de Pocket ----------
// El panel decide y el bot abre la operacion en la cuenta DEMO (ver src/botbridge.js y
// trader\pocket_tyl\lector.py). El bot contesta con el precio y la hora exactos de la entrada, el
// pago real de esa operacion y, al cerrar, el resultado que da la plataforma: con eso se cuenta
// el plazo y se decide la martingala. Si el bot no esta abierto, falla o rechaza la orden, el
// panel sigue como sin bot (espera la entrada a mano).
// Solo se manda una orden si la fuente interna esta activa: es la prueba de que la grafica de la
// pantalla es del par escrito en "Activo" (si no, el bot operaria un par y el panel leeria otro).
// Registro: O,ms,enviada,lado,nivel · O,ms,abierta,id,precio,pago,monto,ms · O,ms,resultado,win|loss|tie,neto,cierre · O,ms,fallo,motivo
const bot = createBotBridge();
let botLogged = 'false|'; // ultimo estado del bot anotado en el registro
let botOrder = null; // orden del bot para la senal en curso: { signal, state: 'sending'|'open'|'done'|'failed', ... }
/** Por que el bot no opera ahora ('' = puede operar). */
function botPause() {
  if (!config.autoTrade) return 'apagado en ajustes';
  const status = bot.status();
  if (!status.online) return status.connected && status.demo !== true ? 'su cuenta no es DEMO' : 'el bot no está abierto';
  if (!config.asset) return 'falta escribir el par en «Activo»';
  if (sourceInfo.active !== 'INTERNA') return 'no confirmo que la gráfica sea de ese par (fuente interna inactiva)';
  return '';
}
/** Automatico en espera: el bot esta abierto pero no se puede confirmar el par en la pantalla. */
const autoHold = () => !config.manual && config.autoTrade && bot.status().online && sourceInfo.active !== 'INTERNA';
/** Manda al bot la senal (o martingala) que acaba de salir. */
function sendToBot(signal, now) {
  const order = { signal, state: 'sending', sentAt: now, level: signal.martin || 0, dir: signal.dir, error: '' };
  botOrder = order;
  record(`O,${now},enviada,${order.dir},${order.level}`);
  const plain = (text) => String(text || '').replace(/[,\r\n]+/g, ' ').slice(0, 160);
  bot
    .order({ asset: config.asset, dir: order.dir, seconds: config.cycleSeconds, level: order.level })
    .then((opened) => {
      if (!opened || !opened.ok) throw new Error((opened && opened.error) || 'sin respuesta del bot');
      order.state = 'open';
      order.id = opened.id;
      order.openPrice = opened.open_price;
      order.payout = opened.payout;
      if (Number(opened.payout) > 0) botPaid = { value: Number(opened.payout), at: Date.now() };
      order.amount = opened.amount;
      // La orden entro entre que se mando y que Pocket la confirmo: se toma el punto medio.
      order.enteredAt = Math.round((opened.sent_ms + opened.open_ms) / 2);
      // Pocket cierra en un segundo entero de su reloj: una operacion "de 3 s" dura 3 s menos la
      // fraccion del segundo en que entro. El bot dice cuando cierra; el panel cuenta hasta ahi.
      order.closeAt = Number.isFinite(opened.close_ms) ? opened.close_ms : null;
      record(`O,${Date.now()},abierta,${opened.id},${opened.open_price},${opened.payout},${opened.amount},${opened.open_ms - opened.sent_ms}`);
      return bot.result(opened.id, config.cycleSeconds).then((done) => {
        if (!done || !done.ok) throw new Error((done && done.error) || 'sin resultado del bot');
        order.result = done.result;
        order.net = done.net;
        order.state = 'done';
        record(`O,${Date.now()},resultado,${done.result},${done.net},${done.close_price}`);
      });
    })
    .catch((err) => {
      if (order.state === 'sending') order.state = 'failed'; // no entro: queda la entrada a mano
      order.error = err.message;
      record(`O,${Date.now()},fallo,${plain(err.message)}`);
    });
}

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
  seen: null, // la vela en curso tal como estaba al preguntar (ver src/lastcandle.js)
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
    } else {
      // E,ms,ia-tarde,ia,ms que tardo: contesto cuando la senal ya habia salido (no se uso).
      record(`E,${Date.now()},ia-tarde,${id},${Date.now() - startedAt}`);
    }
  } catch (err) {
    // E,ms,ia-fallo,ia,ms que llevaba,motivo: no contesto a tiempo o dio error (la senal sale sin ella).
    record(`E,${Date.now()},ia-fallo,${id},${Date.now() - startedAt},${String(err && err.message).replace(/[,\r\n]+/g, ' ').slice(0, 140)}`);
    if (requestId !== council.requestId) return; // respuesta de una consulta ya descartada
    const slow = /tardó/.test(err.message) ? ' Elige en ⚙ un modelo más rápido o sube la pausa.' : '';
    ai.status = `IA (${model}): ${err.message}${slow} Esta señal sale sin ella.`;
  } finally {
    ai.busy = false;
  }
}

/**
 * Soporte y resistencia para las IA: EXACTAMENTE los que se dibujan sobre la grafica (`levels`).
 * Sustituyen a los dos datos de nivel de las lecturas; lo demas de las lecturas no cambia.
 */
function levelForAi(level, price) {
  if (!level || !levels || !(levels.tipica > 0) || price === null) return null;
  const gap = Math.abs(level.precio - price);
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    distancia: round1(gap / levels.tipica), // en "velas": 1 = tamano de una vela tipica
    toques: level.toques,
    estado: level.invertido ? 'invertido' : 'vigente',
    ...(axis ? { distancia_pips: round1((gap * axis.perPixel) / axis.pip) } : {}),
  };
}
function readingsForAi(readings, price) {
  if (!readings) return null;
  return {
    ...readings,
    soporte_abajo: levels ? levelForAi(levels.soporte, price) : null,
    resistencia_arriba: levels ? levelForAi(levels.resistencia, price) : null,
    niveles_explicacion:
      'soporte y resistencia mas cercanos, medidos con pivotes de las ultimas 80 velas (son las dos lineas que el panel dibuja). ' +
      'vigente = el precio no lo ha cruzado desde su ultimo toque; invertido = lo cruzo una vez y ahora hace el papel contrario ' +
      '(soporte roto que hace de resistencia, o al reves). null = no hay nivel confirmado de ese lado',
  };
}

/**
 * Segundos que se pide predecir. Con el boton PREDECIR la senal vale hasta el CIERRE de la vela
 * en curso: lo que le faltara a la vela cuando salga la senal (tras la pausa de analisis). En
 * automatico, o si aun no se sabe cuanto dura la vela, los segundos de siempre.
 */
function horizonSeconds() {
  if (!closeMode() || !clockInfo || !clockInfo.known) return config.cycleSeconds;
  const pauseMs = instantMode() ? 0 : config.pauseSeconds * 1000;
  return Math.max(1, Math.round((clockInfo.remainingMs - pauseMs) / 1000));
}

/**
 * Pide su opinion a todas las IA activas a la vez, con los mismos numeros.
 * @param {number} windowMs  Tiempo que falta para dar la senal: es lo que tienen para contestar.
 */
function askCouncil(candles, moves, ticks, windowMs, readings = null, timing = null) {
  council.answers = {};
  const ids = enabledAis().filter((id) => !ais[id].busy);
  if (ids.length === 0 || candles.length < MIN_CANDLES) {
    // E,ms,ia-sin-preguntar,motivo: la consulta no llego a salir.
    record(`E,${Date.now()},ia-sin-preguntar,${ids.length === 0 ? `ocupadas: ${enabledAis().filter((id) => ais[id].busy).join(' ') || 'ninguna activa'}` : `pocas velas: ${candles.length}`}`);
    return;
  }
  // (Con `timing` la ventana ya esta medida contra el momento en que sale la senal: no aplica el
  // minimo de la pausa. Sin esto, la martingala analizada de la version j nunca llego a preguntar:
  // su ventana de 2.5 s quedaba por debajo del minimo de 3 s.)
  if (!timing && windowMs < AI_MIN_PAUSE_SECONDS * 1000) {
    for (const id of ids) ais[id].status = `IA en espera: pon la pausa de análisis en ${AI_MIN_PAUSE_SECONDS} s o más para darle tiempo.`;
    return;
  }
  const requestId = ++council.requestId;
  council.deadlineAt = Date.now() + windowMs - 400;
  const snapshot = describeChart(candles, moves, horizonSeconds(), {
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
  // Con el boton PREDECIR la senal vale hasta el cierre de la vela en curso: se les dice tal cual.
  const toClose = closeMode() && Boolean(clockInfo && clockInfo.known);
  if (toClose) {
    snapshot.objetivo =
      'la operacion vale hasta el CIERRE de la vela en curso (le faltan los segundos indicados en "segundos_a_predecir"): ' +
      'di si la vela cerrara por encima (up) o por debajo (down) del precio del momento de tu respuesta';
  }
  // PREGUNTA TARDE: se les dice cuando se abrira de verdad la operacion (no cuando contesten).
  if (timing) {
    snapshot.cuando_se_abre_la_operacion = {
      en_segundos: Math.round(timing.opensInMs / 100) / 10,
      explicacion: timing.atCandleOpen
        ? 'la operacion NO se abre cuando respondes: se abre cuando CIERRE la vela en curso y abra la siguiente (en esos segundos). ' +
          `Predice donde estara el precio ${config.cycleSeconds} segundos despues de esa apertura, respecto al precio de esa apertura. ` +
          'La vela en curso todavia puede cambiar en lo que le falta: fijate hacia donde va cerrando'
        : `la operacion se abre en esos segundos: predice donde estara el precio ${config.cycleSeconds} segundos despues de ese momento, respecto al precio de ese momento`,
    };
  }
  // A cada IA se le agregan SUS predicciones anteriores en esta grafica y lo que paso despues:
  // no recuerdan nada entre consultas, asi que es la unica forma de que puedan corregirse.
  for (const id of ids) {
    const personal = { ...snapshot };
    const feedback = feedbackFor(council.memory[id]);
    if (feedback) personal.tus_ultimas_predicciones = feedback;
    // La operacion se abre cuando llega la respuesta, no cuando se pregunta: se le dice cuanto
    // suele tardar para que prediga el tramo que empieza entonces.
    if (ais[id].lastMs && !timing) {
      personal.tu_respuesta_tarda = {
        segundos: Math.round((ais[id].lastMs + entryMs()) / 100) / 10,
        explicacion:
          'lo que tardaste en responder la ultima vez, mas lo que tarda la persona en poner la orden. La operacion se abre entonces: predice donde estara el precio ' +
          (toClose
            ? 'AL CIERRE de la vela en curso, respecto al precio de ese momento (no respecto al de estos datos)'
            : `${config.cycleSeconds} segundos DESPUES de ese momento, respecto al precio de ese momento (no respecto al de estos datos)`),
      };
    }
    // (Entero: AbortSignal.timeout rechaza un plazo con decimales, y lo que le falta a la vela los trae.)
    askOne(id, personal, Math.max(500, Math.round(windowMs - 400)), requestId);
  }
  // E,ms,ia-pregunta,a quienes,plazo en ms
  record(`E,${Date.now()},ia-pregunta,${ids.join(' ')},${Math.round(windowMs - 400)}`);
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
    if (typeof saved.untilClose === 'boolean') config.untilClose = saved.untilClose;
    if (typeof saved.patternVeto === 'boolean') config.patternVeto = saved.patternVeto;
    if (typeof saved.antiRebound === 'boolean') config.antiRebound = saved.antiRebound;
    if (typeof saved.internalSource === 'boolean') config.internalSource = saved.internalSource;
    if (Number.isFinite(saved.martinLevels)) config.martinLevels = Math.max(0, Math.min(MARTIN_MAX_LEVELS, Math.round(saved.martinLevels)));
    if (Number.isFinite(saved.entryWaitSeconds)) config.entryWaitSeconds = Math.max(0, Math.min(30, Math.round(saved.entryWaitSeconds)));
    if (typeof saved.autoTrade === 'boolean') config.autoTrade = saved.autoTrade;
    if (typeof saved.newCandle === 'boolean') config.newCandle = saved.newCandle;
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
  // La vela en curso no se ve (algo la tapa, o la grafica esta movida hacia atras): no se marca una vieja.
  // Con la fuente interna los numeros siguen llegando aunque algo tape la grafica: se avisa.
  if (config.cycleSeconds > 0 && sourceInfo.active === 'INTERNA' && blindReads >= BLIND_READS_TO_WARN) {
    return 'Gráfica tapada: sigo leyendo con la fuente interna';
  }
  if (config.cycleSeconds > 0 && missingReads >= MISSING_READS_TO_WARN && last.status !== 'no-price') {
    return 'La vela actual no está a la vista (algo la tapa o la gráfica está movida hacia atrás)';
  }
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
    // Porcentaje de confianza de la senal en curso: acierto medido de las senales de su mismo nivel.
    confidence: confidenceOf(last.signal),
    // Patron que disparo la senal en curso, con su acierto y P&L medidos (ultimas 100 de ese patron).
    pattern: patternInfo(last.signal),
    // Senal vetada (anti-rebote o patron desactivado por estadistica): que veto fue y hacia donde iba.
    veto: last.signal && last.signal.veto ? { kind: last.signal.veto.kind, dir: last.signal.veto.dir } : null,
    // Tabla completa por patron (para el detalle) y lo medido en papel del veto anti-rebote.
    patterns: PATTERN_KEYS.filter((key) => patternTable[key]).map((key) => ({ ...patternTable[key], text: PATTERNS[key], off: Boolean(config.patternVeto && patternOff(patternTable[key]) !== null) })),
    rebound: reboundTally,
    // Lo medido en papel de la confirmacion con la vela cerrada (senales que no entraron).
    candleCheck: candleTally,
    // Martingala en analisis (su nivel): sale al abrir la vela nueva.
    thinking: last.thinking || 0,
    // Seguimiento: como va la senal en curso, si se avisa martingala, y lo medido de las martingalas.
    follow: last.follow || null,
    // Bot en DEMO: si esta disponible, por que no opera (si no opera) y como va su orden de esta senal.
    bot: {
      hold: autoHold(), // automatico en espera: no se confirma el par en la pantalla
      enabled: config.autoTrade,
      online: bot.status().online,
      balance: bot.status().balance,
      pause: botPause(),
      order: botOrder ? { state: botOrder.state, level: botOrder.level, amount: botOrder.amount || null, payout: botOrder.payout || null, error: botOrder.error || '' } : null,
    },
    // Dos etapas: mientras se espera la entrada del usuario, cuanto le queda; y si ya entro, hace cuanto.
    entryWait: last.entryWait || null,
    entryWaitSeconds: config.entryWaitSeconds,
    entered: last.enteredAgoMs !== null && last.enteredAgoMs !== undefined,
    martinLevels: config.martinLevels,
    martin: martinTally,
    newCandle: config.newCandle,
    patternVeto: config.patternVeto,
    antiRebound: config.antiRebound,
    internalSource: config.internalSource,
    // Salud de los datos: fuente activa (INTERNA / PÍXELES), edad del ultimo dato interno y aviso.
    source: { ...sourceInfo, ageSeconds: sourceInfo.ageMs === null ? null : Math.round(sourceInfo.ageMs / 100) / 10, warn: Boolean(config.internalSource && sourceInfo.active !== 'INTERNA' && sourceInfo.stale) },
    payoutNow: payoutNow(), // pago de este momento y de donde sale (interna / config)
    // Entrada sugerida de la senal en curso: donde esperar el precio y si ya llego.
    entry: last.entry ? { kind: last.entry.text, filled: last.entry.filled, zone: Boolean(last.entry.zone), inZone: last.entry.inZone } : null,
    readings: last.readings || null, // lecturas en vivo (tendencia, vela actual, precio)
    // Las 8 lecturas del panel (sin los datos internos) y cuantas velas hay en el historial.
    panel:
      panel && config.cycleSeconds > 0
        ? panel.items.map((r) => ({ key: r.key, name: r.name, text: r.text, lean: r.lean, spark: r.spark || null, detail: r.detail }))
        : null,
    historyCandles: panel ? panel.candles : 0,
    price: config.cycleSeconds > 0 ? priceText : null, // precio actual leido del eje (null si no se ve el eje)
    pips: Boolean(axis), // las distancias salen en pips
    scanning: scanningNow(), // se esta escaneando la grafica (haz y recuadro de cada vela)
    // Lo que se dibuja sobre la grafica. El marcador de la vela actual y los niveles van siempre
    // que el panel esta leyendo; el haz y los recuadros, solo durante el analisis.
    scan: scanningNow() || followingNow() ? scanInfo : null,
    // PREDECIR alineado con la vela: se espera a que abra la siguiente y la senal vale hasta su cierre.
    untilClose: Boolean(last.untilClose),
    clockKnown: Boolean(clockInfo && clockInfo.known),
    candleSeconds: clockInfo ? clockInfo.seconds : 0,
    entryDelay: Math.round(entryMs() / 100) / 10, // segundos que tarda el usuario en entrar tras la senal
    // Patron medido en el precio real de esta grafica, al plazo de la senal.
    regime: regime && config.cycleSeconds > 0 ? { kind: regime.kind, text: regime.text } : null,
    // Memoria del mercado: que paso otras veces tras una racha de velas como la actual.
    memory: memoryInfo && config.cycleSeconds > 0 ? { text: memoryInfo.text, votes: memoryInfo.vote !== 0, total: memoryInfo.total } : null,
    // El minimo para no perder se calcula con el pago de este momento (el real, si se conoce).
    trades: { ...summarize(trades, payoutNow().value), last: trades.last },
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
      // (Con el boton PREDECIR la senal vale hasta el cierre de la vela, no un numero fijo de
      // segundos: de ahi no se puede estimar el retraso de entrada, y tampoco hace falta.)
      if (!config.manual && lastSignalAt && sample > -700 && sample < ENTRY_MAX_MS + 2000) {
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
      const pixelsOk = check.forming && check.complete && verified;
      const pixelPriceY = priceY; // donde la pantalla muestra el precio (para el marcador de la vela)
      const pixelForming = candles[candles.length - 1] || null;

      // FUENTE INTERNA: si esta disponible y cuadra con la grafica, los numeros (velas, precio y
      // reloj de la vela) salen de ahi; si no, de los pixeles, como siempre.
      const wasInternal = sourceInfo.active === 'INTERNA';
      const inner = internalView(now, candles, pixelsOk);
      if (wasInternal && !inner) liveClock.reset(); // el reloj por pixeles se vuelve a poner en hora
      blindReads = inner && !pixelsOk ? blindReads + 1 : 0;
      const formingOk = inner ? true : pixelsOk;
      const forming = inner ? inner.candles[inner.candles.length - 1] : pixelForming;

      // Eje de precios: se lee en cada lectura (es barato: recuerda los digitos ya vistos).
      // Da la cotizacion real, que no depende de las velas.
      let price;
      let quote;
      if (inner) {
        axis = inner.axis;
        priceY = inner.priceY;
        price = inner.price;
        quote = inner.quote;
        priceText = inner.priceText;
      } else {
        axis = readAxis(pixels.data, pixels.width, pixels.height, pixelForming ? pixelForming.x1 + 4 : 0);
        price = axis && axis.anchored && priceY !== null ? axis.at(priceY) : null;
        quote = price === null ? null : { value: price, perPixel: axis.perPixel };
        priceText = price === null ? null : price.toFixed(axis.decimals);
      }
      if (priceText) {
        record(`T,${now},${priceText},${axis.pip}${inner ? ',i' : ''}`); // registro del precio real (i = fuente interna)
        const lastQuote = track[track.length - 1];
        if (!lastQuote || now - lastQuote.time >= TRACK_STEP_MS) track.push({ time: now, value: price });
        while (track.length && now - track[0].time > trackMemoryMs()) track.shift();
      }

      // Se puede medir el precio si hay cotizacion real, o si las velas se leen bien (para medirlo
      // respecto a ellas). Solo si no hay ninguna de las dos se espera a que se destape.
      const clean = priceY !== null && (quote !== null || formingOk);
      coverReason = clean ? null : check.reason;

      // Velas para el analisis: las de la fuente interna; si no, las de esta lectura si son de
      // fiar; si algo las tapa, las ultimas buenas (el precio se sigue midiendo en vivo de todas formas).
      if (pixelsOk) goodCandles = { time: now, candles };
      let usable = pixelsOk || !goodCandles || now - goodCandles.time > GOOD_CANDLES_MS ? candles : goodCandles.candles;
      if (inner) usable = inner.candles;

      let closedDetected = false; // en esta lectura (verificada) se vio cerrar una vela
      if (formingOk) {
        // Historial largo: con la fuente interna ya viene completo; por pixeles se va acumulando.
        const hist = inner ? { candles: inner.closed.slice(-60), added: inner.added, prices: [] } : history.update(candles, priceY, now, trackMemoryMs());
        closedDetected = hist.added.length > 0;
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
            candleStartedAt = inner ? inner.clock.startedAt : now; // acaba de cerrar una vela: empieza la siguiente
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
        longCandles = forming && hist.candles.length ? [...hist.candles, forming] : usable;
        // Soporte y resistencia: ultimas 80 velas cerradas + la vela en curso + el precio de ahora.
        // Lo que sale de aqui es lo que se dibuja y lo que se les manda a las IA.
        const levelCandles = inner ? inner.closed : levelHistory.update(candles, priceY, now, 1000).candles;
        // Nivel firme: con la fuente interna se recuerda el PRECIO real de los niveles dibujados (la
        // escala de la pantalla cambia) y se conservan mientras sigan siendo validos.
        const keep =
          inner && levelMemo
            ? {
                soporte: levelMemo.soporte !== null ? { precio: -inner.axis.rowOf(levelMemo.soporte) } : null,
                resistencia: levelMemo.resistencia !== null ? { precio: -inner.axis.rowOf(levelMemo.resistencia) } : null,
              }
            : null;
        levels = forming ? niveles([...levelCandles, forming], priceY !== null ? -priceY : forming.close, keep) : null;
        levelMemo =
          inner && levels
            ? {
                soporte: levels.soporte ? inner.axis.at(-levels.soporte.precio) : null,
                resistencia: levels.resistencia ? inner.axis.at(-levels.resistencia.precio) : null,
              }
            : null;
      }
      // Reloj de la vela en curso. Con la fuente interna es exacto (la hora del servidor). Por
      // pixeles se pone en hora al ver cerrar una vela; si a la hora del cierre la grafica estaba
      // tapada, el cierre lo da el reloj.
      clockInfo = inner
        ? inner.clock
        : liveClock.update({ now, closed: closedDetected, seconds: memoryInfo && memoryInfo.candleSeconds ? memoryInfo.candleSeconds : 0 });
      // Entrada del usuario: mientras se espera, se cuentan los blancos junto a la vela en curso
      // (la marca "▼ $1" que dibuja la plataforma). Si suben respecto al inicio de la espera, entro.
      let userEntered = false;
      if (last.entryWait && pixelForming) {
        // (15 nov, tras la primera prueba real) NO se descuenta la zona del globo de resultado: la
        // marca de la entrada siguiente (la de la martingala) cae justo encima o al lado del globo
        // de la operacion que acaba de cerrar, y descontandola no se veia. En su lugar, cuando
        // APARECE un globo se vuelve a tomar la base (sus letras blancas no son una entrada).
        const white = countOrderMark(pixels.data, pixels.width, pixels.height, {
          x0: pixelForming.x0,
          x1: pixelForming.x1,
          row: pixelPriceY !== null ? pixelPriceY : -pixelForming.close,
        });
        if (white !== null) {
          if (!entryWasWaiting || badges.length > entryBadges) {
            entryBase = white; // primera lectura de la espera, o acaba de salir un globo: lo que ya habia
            entryHits = 0;
          }
          entryBadges = badges.length;
          const seen = entryWasWaiting && white - entryBase >= MARK_MIN;
          // Dos lecturas seguidas: un globo de resultado a medio dibujar (aun sin reconocer) dura una.
          entryHits = seen ? entryHits + 1 : 0;
          userEntered = entryHits >= 2;
          if (!seen) entryBase = Math.min(entryBase, white); // una marca vieja que se quita baja la base
          entryWasWaiting = true;
        }
      } else entryWasWaiting = false;
      // Bot: si abrio la operacion de esta senal, ESA es la entrada (precio y hora exactos) y el
      // resultado sera el que de la plataforma. Mientras el bot la esta abriendo no se mira la marca.
      const mine = botOrder && botOrder.signal === shownSignal ? botOrder : null;
      let externalAwait = false;
      let externalResult = null;
      if (mine && mine.state !== 'failed') {
        userEntered = false;
        if ((mine.state === 'open' || mine.state === 'done') && !mine.told) {
          mine.told = true;
          const span = config.cycleSeconds * 1000;
          const left = mine.closeAt ? mine.closeAt - now : null; // lo que falta para el cierre que dio Pocket
          userEntered = { price: mine.openPrice, agoMs: left !== null && left > 0 && left <= span ? span - left : Math.max(0, now - mine.enteredAt) };
        }
        externalAwait = mine.state === 'open' && !mine.error;
        externalResult = mine.result || null;
      }
      const advice = councilAdvice(now);
      // Confirmacion con la vela cerrada: como esta ahora la vela que se les enseno a las IA.
      const lastCandle = advice && council.seen ? candleChange(council.seen, usable, clockInfo, now) : null;
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
        payout: payoutNow().value,
        advice,
        force: config.alwaysSignal,
        // Automatico con el bot abierto: si la grafica del par no esta confirmada (fuente interna
        // inactiva) no se predice a ciegas ni se gasta en consultas: se espera, como en manual.
        manual: config.manual || autoHold(),
        waitForAdvice: anyAi() && anyAiBusy() && !instantMode(),
        // Con el boton PREDECIR la senal vale hasta el cierre de la vela (y, si WAIT_FOR_NEXT_CANDLE,
        // con la vela avanzada se espera a que abra la siguiente).
        align: closeMode(),
        waitNext: WAIT_FOR_NEXT_CANDLE,
        // Entrada sugerida: linea en la orilla o a media zona; la senal se mide desde que el precio llega.
        suggest: config.manual,
        // Con la senal al abrir la vela y la fuente interna encendida, el unico reloj que vale es
        // el exacto (el de la fuente interna): con el de pixeles, o sin reloj, no se predice.
        waitClock: Boolean(config.newCandle && config.internalSource),
        openLeadMs: config.autoTrade && !botPause() ? OPEN_LEAD_MS : 0,
        candle: {
          ...clockInfo,
          known: Boolean(clockInfo && clockInfo.known && (inner || !(config.newCandle && config.internalSource))),
          // Fila del cierre de la ultima vela cerrada, solo si esta lectura es de fiar.
          closeRow: formingOk && usable.length >= 2 ? -usable[usable.length - 2].close : null,
        },
        // Vetos (15 nov 2026): anti-rebote y patrones desactivados por estadistica.
        antiRebote: config.antiRebound,
        vetoedPatterns: vetoedPatterns(),
        // Seguimiento: si la senal pierde, sale una martingala en ese instante (hasta este tope).
        martin: config.martinLevels,
        // La martingala se analiza: con IA se le espera hasta 2.5 s; sin IA deciden las reglas al momento.
        martinThinkMs: anyAi() && !instantMode() ? MARTIN_THINK_MS : 0,
        // La prediccion sale al abrir cada vela nueva (analisis al final de la vela en curso).
        newCandle: config.newCandle,
        lastCandle,
        // Dos etapas: se espera la entrada del usuario y el plazo cuenta desde que entra.
        entryWaitMs: config.entryWaitSeconds * 1000,
        userEntered,
        externalAwait,
        externalResult,
      });
      // Registro de las dos etapas: E,ms,espera-entrada,segundos · E,ms,entro,segundos que tardo
      if (last.entryWait && !entryStageLogged) {
        entryStageLogged = true;
        entryStageAt = now;
        record(`E,${now},espera-entrada,${Math.round(last.entryWait.totalMs / 100) / 10}`);
      } else if (!last.entryWait && entryStageLogged) {
        entryStageLogged = false;
        if (last.phase === 'signal' && last.enteredAgoMs !== null) record(`E,${now},entro,${Math.round((now - entryStageAt) / 100) / 10}`);
      }
      // Empieza una senal nueva / termina la anterior. Con seguimiento, de una senal que pierde se
      // pasa directo a su martingala sin salir de la fase 'signal': por eso se mira si cambio la senal.
      const signalStarted = last.phase === 'signal' && Boolean(last.signal) && (previousPhase !== 'signal' || last.signal !== shownSignal);
      const signalEnded = previousPhase === 'signal' && (last.phase !== 'signal' || signalStarted);
      shownSignal = last.phase === 'signal' ? last.signal : null;
      // Senales vetadas que acaban de medirse en papel: a la estadistica y al registro.
      for (const v of last.vetoResults || []) {
        addPatternOp(now, { pattern: v.pattern, dir: v.dir, result: v.result, kind: v.kind === 'patron' ? 'veto-patron' : v.kind === 'vela' ? 'veto-vela' : 'veto-rebote' });
      }
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
          payout: payoutNow().value,
          force: config.alwaysSignal,
          manual: true,
        });
        instantScore = shadowResult.live;
      }
      // Precio de entrada de la senal en curso: el del momento en que el usuario entra (la senal
      // mas su retraso de entrada). Sirve para dibujar la linea de entrada y decir, en vivo,
      // cuantos pips va a favor o en contra.
      // Al salir la senal se anota el precio de ese instante: ahi va la linea de COMPRA / VENTA sugerida.
      if (signalStarted) entry = { at: now, signalPrice: price, signalRow: priceY, price: null, taken: false };
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
        const liveCurrent = Boolean(inner) || (pixelPriceY !== null && check.forming && candles.length >= 3);
        // Solo se marca la vela EN CURSO de verdad. Con la fuente interna se conoce por su HORA (la del
        // servidor), este o no dibujada todavia: una vela que acaba de abrir no tiene cuerpo, en la
        // pantalla no se ve, y antes el marcador se regresaba a la vela anterior (15 nov 2026). El
        // tiempo no retrocede: el marcador tampoco. Por pixeles se marca la de esta lectura; si no
        // esta a la vista (grafica movida hacia atras, o algo la tapa) el marcador se oculta y se avisa.
        const current = inner ? usable[usable.length - 1] : liveCurrent ? candles[candles.length - 1] : null;
        missingReads = liveCurrent || candles.length < 3 ? 0 : missingReads + 1;
        // Numero de cada vela (arriba del margen): con la fuente interna sale de su hora, asi que es
        // siempre el mismo para la misma vela y solo crece; por pixeles se cuenta cada cierre visto.
        if (!inner && clockInfo && clockInfo.closedNow) candleSerial++;
        const serialOf = (c, fromEnd) => (inner && Number.isFinite(c.time) && clockInfo && clockInfo.seconds ? Math.floor(c.time / clockInfo.seconds) : candleSerial - fromEnd);
        const inPips = (px) => (axis ? Math.round((10 * Math.abs(px) * axis.perPixel) / axis.pip) / 10 : null);
        const top = current ? Math.max(current.open, current.close) : 0;
        const bottom = current ? Math.min(current.open, current.close) : 0;
        const dirSign = last.signal && last.signal.dir === 'down' ? -1 : 1;
        // Soporte y resistencia de src/levels.js: fila en pantalla, toques y si esta invertido.
        const levelMark = (level) => (level ? { row: o - level.precio / k, touches: level.toques, flipped: level.invertido } : null);
        scanInfo = {
          // 'analysis' = haz y recuadro de cada vela; 'signal' = senal en curso; 'follow' = solo se
          // sigue la vela actual (en reposo, o esperando a que abra la vela siguiente).
          mode: last.phase === 'signal' ? 'signal' : scanningNow() ? 'analysis' : 'follow',
          verified,
          rate: readsPerSecond(now), // lecturas de pantalla por segundo en este momento
          candles: usable.map((c) => ({ x: o + c.x0 / k, w: (c.x1 - c.x0 + 1) / k, y: o - c.high / k, h: (c.high - c.low) / k, up: c.dir === 'up' })),
          support: levels ? levelMark(levels.soporte) : null,
          resistance: levels ? levelMark(levels.resistencia) : null,
          // La vela en curso no esta a la vista (se avisa a partir de la segunda lectura seguida).
          missing: missingReads >= MISSING_READS_TO_WARN,
          saved: memoryInfo ? memoryInfo.total : 0, // velas guardadas en la memoria del mercado
          // Regla de arriba del margen: el numero de cada vela (dos cifras) y cual es la que esta en curso.
          ruler: usable
            .map((c, i) => ({ x: o + c.x0 / k, w: (c.x1 - c.x0 + 1) / k, n: ((serialOf(c, usable.length - 1 - i) % 100) + 100) % 100, current: i === usable.length - 1 && Boolean(current) }))
            .filter((mark) => Number.isFinite(mark.x)),
          byTime: Boolean(inner), // los numeros salen de la hora de cada vela (fuente interna)
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
                bodyPips: inPips(top - bottom),
                upperPips: inPips(current.high - top),
                lowerPips: inPips(bottom - current.low),
                pattern: last.readings ? last.readings.candle.text : '',
                figure: last.formation ? last.formation.name : '', // figura de varias velas detectada
                moving: last.readings ? last.readings.price.text : '',
                lean: last.readings ? last.readings.price.lean : 'flat',
                quote: priceText,
                // Reloj de la vela (src/candleclock.js): segundos que lleva, cuanto dura y cuanto le falta.
                elapsed: clockInfo && clockInfo.elapsedMs !== null ? Math.round(clockInfo.elapsedMs / 100) / 10 : null,
                seconds: clockInfo ? clockInfo.seconds : 0, // 0 = aun no se sabe cuanto dura
                remaining: clockInfo && clockInfo.known ? Math.round(clockInfo.remainingMs / 100) / 10 : null,
              }
            : null,
          // Senal en curso: linea en el precio de entrada y como va en este instante.
          // Linea de COMPRA / VENTA sugerida: aparece en cuanto sale la senal, en el precio de ese
          // instante. Cuando llega el momento de entrada del usuario se pasa a ese precio y
          // empieza a decir cuantos pips va ganando o perdiendo.
          entry: (() => {
            if (!last.signal || !last.signal.dir) return null;
            // Entrada sugerida (src/entry.js): la linea va en la orilla o a media zona; punteada
            // mientras el precio no llega, y firme desde que llega ("entrada tomada").
            const plan = last.entry;
            if (plan) {
              if (plan.row === null) return null; // en esta lectura no se puede ubicar la linea
              const withQuote = Boolean(axis) && axis.anchored && price !== null;
              const base = withQuote ? axis.at(plan.row) : null;
              return {
                dir: last.signal.dir,
                confidence: last.signal.confidence,
                suggested: true,
                kind: plan.text, // 'orilla alta' | 'orilla baja'
                // Zona de entrada: las dos lineas entre las que esta bien entrar, y si el precio sigue dentro.
                zone: plan.zone
                  ? {
                      best: o + plan.zone.best / k,
                      limit: o + plan.zone.limit / k,
                      inside: plan.inZone,
                      bestQuote: withQuote ? axis.at(plan.zone.best).toFixed(axis.decimals) : null,
                      limitQuote: withQuote ? axis.at(plan.zone.limit).toFixed(axis.decimals) : null,
                    }
                  : null,
                taken: plan.filled,
                row: o + plan.row / k,
                quote: withQuote ? base.toFixed(axis.decimals) : null,
                pips: withQuote && plan.filled ? Math.round((10 * dirSign * (price - base)) / axis.pip) / 10 : null, // + ganando, - perdiendo
                // Sin el eje no hay pips: se dice al menos si va a favor o en contra de la entrada.
                ahead: plan.filled && priceY !== null ? Math.sign((plan.row - priceY) * dirSign) : 0,
              };
            }
            if (!entry) return null;
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

      // Registro: como termino la senal anterior y, si empieza otra, cual es.
      if (signalEnded && last.lastResult) {
        record(`R,${now},${last.lastResult.replace(/,/g, ' ')}`);
        // Acierto medido por nivel de confianza (solo senales con lado).
        // Si la opero el bot, el pago es el de ESA operacion (el de la cuenta), no el estimado.
        const paid = openSignal && openSignal.order && Number.isFinite(openSignal.order.payout) ? { value: openSignal.order.payout, source: 'bot' } : null;
        if (openSignal && openSignal.dir && openSignal.martin) {
          // Martingala de seguimiento: se anota aparte (tipo martin1, martin2...), no en la estadistica por patron.
          addPatternOp(now, { pattern: openSignal.pattern, dir: openSignal.dir, result: last.lastResult, kind: `martin${openSignal.martin}`, paid });
        } else if (openSignal && openSignal.dir) {
          countConfidence(openSignal.confidence, last.lastResult);
          // Estadistica por patron: patron, pago de este momento y resultado (linea P del registro).
          addPatternOp(now, { pattern: openSignal.pattern, dir: openSignal.dir, result: last.lastResult, kind: 'op', paid });
        }
        openSignal = null;
        // Justo ahora la plataforma dibuja el globo del resultado: se guardan dos imagenes de la
        // zona para poder revisar despues por que un globo se conto o no.
        autoShots = [now + 600, now + 2200];
      }
      if (signalStarted) {
        lastSignalAt = now;
        // Ultimo campo: "cierre:N" = la senal vale hasta el cierre de la vela (le faltaban N s).
        const until = last.untilClose ? `cierre:${Math.round((last.remainingMs || 0) / 100) / 10}` : '';
        // Los dos ultimos campos (15 nov): patron de la senal y, si quedo vetada, que veto fue.
        const setup = last.signal.pattern ? last.signal.pattern.key : '';
        const veto = last.signal.veto;
        record(`S,${now},${last.signal.dir || 'wait'},${last.signal.source},${last.signal.confidence},${config.cycleSeconds},${regime && regime.kind ? regime.kind : ''},${until},${setup},${veto ? veto.kind : ''}`);
        openSignal = { dir: last.signal.dir, confidence: last.signal.confidence, filled: false, pattern: setup || 'otro', martin: last.signal.martin || 0 };
        // Bot en DEMO: la senal (o su martingala) se manda al bot, que abre la operacion.
        botOrder = null;
        if (last.signal.dir && last.entryWait && !botPause()) {
          sendToBot(last.signal, now);
          openSignal.order = botOrder;
        }
        // E,ms,martingala,nivel,lado: entrada de seguimiento porque la senal anterior perdio.
        if (last.signal.martin) record(`E,${now},martingala,${last.signal.martin},${last.signal.dir}`);
        // Cada veto queda en el registro con su motivo:
        //   E,ms,veto anti-rebote,lado,patron,velas:N cuerpos:a/b x despues:N retroceso:N % extremo
        //   E,ms,veto patron,lado,patron,motivo
        if (veto && veto.kind === 'anti-rebote') {
          const d = veto.data || {};
          record(`E,${now},veto anti-rebote,${veto.dir},${veto.pattern},velas:${d.velas} cuerpos:${(d.cuerpos || []).join('/')}x despues:${d.despues} retroceso:${d.retroceso}% ${d.extremo || ''}`);
        } else if (veto && veto.kind === 'vela') {
          // E,ms,veto vela,lado,patron,iba:color quedo:color   (la vela que miro la IA cambio de color)
          record(`E,${now},veto vela,${veto.dir},${veto.pattern},iba:${veto.data.was} quedo:${veto.data.now}`);
        } else if (veto) {
          record(`E,${now},veto patron,${veto.dir},${veto.pattern},${String(veto.text).replace(/[,\r\n]+/g, ' ')}`);
        }
        if (last.entry) record(`E,${now},zona-entrada,${last.entry.text}`);
        if (photoOnSignal && last.signal.dir) {
          photoOnSignal = false;
          setTimeout(saveScreenPhoto, 900); // con la senal y su zona ya dibujadas
        }
      }
      // Registro: el precio llego a la linea de entrada sugerida.
      if (last.phase === 'signal' && last.entry && last.entry.filled && openSignal && !openSignal.filled) {
        openSignal.filled = true;
        if (last.entry.kind !== 'zona') record(`E,${now},entro,${last.entry.text}`);
      }
      // Registro de la espera de PREDECIR: E,ms,espera-vela,segundos que faltan | E,ms,analisis | E,ms,cancelada
      if (last.phase === 'waiting' && previousPhase !== 'waiting') {
        record(`E,${now},espera-vela,${clockInfo && clockInfo.known ? Math.round(clockInfo.remainingMs / 100) / 10 : ''}`);
      } else if (previousPhase === 'waiting' && last.phase === 'idle') {
        record(`E,${now},cancelada`);
      } else if (last.phase === 'analysis' && previousPhase !== 'analysis') {
        record(`E,${now},analisis,${clockInfo && clockInfo.elapsedMs !== null ? Math.round(clockInfo.elapsedMs / 100) / 10 : ''}`);
      }
      // Marcador de cada IA: al terminar la senal se sabe hacia donde fue el precio de verdad.
      if (signalEnded && council.voted && council.votedDir) {
        const opposite = council.votedDir === 'up' ? 'down' : 'up';
        const actual = last.lastResult === 'acertó' ? council.votedDir : last.lastResult === 'falló' ? opposite : null;
        scoreVotes(council.scores, council.voted, actual);
        rememberOutcome(council.memory, council.votedAnswers, actual);
        council.voted = null;
        council.votedAnswers = null;
      }
      // Empieza una senal: se anota lo que dijo cada IA (para su marcador). Las respuestas ya
      // usadas, o una consulta que no llego a tiempo, dejan de servir.
      if (signalStarted) {
        // Registro para poder revisar despues POR QUE salio cada senal (no cambia nada de la senal):
        //   A,ms,ia,lado,confianza,razon     lo que dijo cada IA
        //   M,ms,razon                        el motivo final que mostro el panel
        //   C,ms,cuerpo,rango,racha,color     la vela en curso al salir la senal: cuerpo y rango en
        //                                     velas tipicas, y cuantas velas cerradas seguidas del mismo color
        const plain = (text) => String(text || '').replace(/[,\r\n]+/g, ' ').slice(0, 200);
        for (const [id, answer] of Object.entries(council.answers)) {
          record(`A,${now},${id},${answer.dir || 'wait'},${answer.confidence || ''},${plain(answer.reason)}`);
        }
        if (last.signal) record(`M,${now},${plain(last.signal.reason)}`);
        // K,ms,segundos de vela,o/h/l/c;...  las ultimas 24 velas en precios reales (si hay cotizacion):
        // con esto se puede repasar despues cualquier regla sobre las velas exactas de cada senal.
        if (axis && axis.anchored) {
          const q = (value) => axis.at(-value).toFixed(axis.decimals);
          record(`K,${now},${clockInfo && clockInfo.seconds ? clockInfo.seconds : ''},${usable.slice(-24).map((c) => `${q(c.open)}/${q(c.high)}/${q(c.low)}/${q(c.close)}`).join(';')}`);
        }
        {
          const closed = usable.slice(0, -1);
          const live = usable[usable.length - 1];
          const ranges = closed.slice(-20).map((c) => c.high - c.low).sort((a, b) => a - b);
          const unit = ranges[Math.floor((ranges.length - 1) / 2)] || 0;
          if (live && unit > 0) {
            const color = closed.length ? closed[closed.length - 1].dir : 'flat';
            let streak = 0;
            for (let i = closed.length - 1; i >= 0 && color !== 'flat' && closed[i].dir === color; i--) streak++;
            const one = (v) => Math.round((10 * v) / unit) / 10;
            record(`C,${now},${one(Math.abs(live.close - live.open))},${one(live.high - live.low)},${streak},${live.dir}/${color}`);
          }
        }
        const votes = Object.entries(council.answers).map(([id, answer]) => [id, answer.dir]);
        council.voted = votes.length ? Object.fromEntries(votes) : null;
        council.votedDir = last.signal ? last.signal.dir : null;
        council.votedAnswers = votes.length ? { ...council.answers } : null;
        council.answers = {};
        council.seen = null;
        council.requestId++;
        council.asked = false;
      }
      // A las IA se les pregunta una vez por prediccion, a todas a la vez.
      //  - Automatico: un poco ANTES de que termine la senal en curso, para que tengan esos
      //    segundos mas toda la pausa de analisis.
      //  - Manual: al pulsar PREDECIR (empieza el analisis); la senal sale en cuanto contestan.
      if (anyAi() && !council.asked && !instantMode()) {
        const pauseMs = config.pauseSeconds * 1000;
        // (Con espera de entrada / bot, la senal no dura un tiempo fijo: a las IA se les pregunta al
        // empezar el analisis, no "un poco antes de que termine la senal".)
        // PREGUNTA TARDE: si se sabe cuanto falta para que salga la senal (sale al abrir la vela, o
        // es una martingala en analisis), se pregunta cuando falta AI_ASK_BEFORE_CLOSE_MS y no antes:
        // asi las IA ven la ultima vela casi completa.
        const synced = Boolean(config.newCandle && clockInfo && clockInfo.known && Number.isFinite(clockInfo.remainingMs));
        // (Con la senal al abrir la vela no se pregunta "antes de que termine la senal en curso": la
        // siguiente saldra al abrir la otra vela, y esa consulta llegaria con mas de 10 s de ventaja.)
        const endingSoon = !synced && !config.manual && !config.entryWaitSeconds && last.phase === 'signal' && last.remainingMs <= AI_LEAD_MS;
        const { untilSignal, tooEarly } = askMoment({
          phase: last.phase,
          thinking: last.thinking || 0,
          remainingMs: last.remainingMs,
          clockLeftMs: synced ? clockInfo.remainingMs : null,
          leadMs: AI_ASK_BEFORE_CLOSE_MS,
        });
        if ((endingSoon || last.phase === 'analysis') && !tooEarly) {
          council.asked = true;
          let windowMs = last.remainingMs;
          if (last.phase === 'signal') windowMs += pauseMs;
          else if (untilSignal !== null) windowMs = untilSignal + AI_ANSWER_GRACE_MS; // el plazo llega hasta que sale la senal
          else if (config.manual) windowMs += AI_MANUAL_EXTRA_MS;
          // Lo que se les ensena de la vela en curso, para confirmar despues con la vela cerrada.
          council.seen = candleSeen(usable, clockInfo, now);
          // Los niveles que reciben las IA son los mismos que estan dibujados (ver readingsForAi).
          const priceNow = priceY !== null ? -priceY : forming ? forming.close : null;
          const timing = last.phase === 'analysis' && untilSignal !== null ? { opensInMs: untilSignal, atCandleOpen: synced } : null;
          askCouncil(longCandles.length ? longCandles : usable, last.moves || [], last.ticks || [], windowMs, panel ? readingsForAi(panel.data, priceNow) : null, timing);
          // E,ms,consulta,segundo de la vela en que se pregunto,segundos que faltan para la senal
          record(`E,${now},consulta,${clockInfo && Number.isFinite(clockInfo.elapsedMs) ? Math.round(clockInfo.elapsedMs / 100) / 10 : ''},${untilSignal !== null ? Math.round(untilSignal / 100) / 10 : ''}`);
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
    // seguimiento de la vela actual sea lo mas fino posible. Tambien mientras se espera a que abra
    // la vela siguiente: asi el analisis arranca en cuanto abre.
    // Con seguimiento, tampoco se deja de leer mientras dura la senal: asi se ve en el momento si va
    // ganando o perdiendo y la martingala sale en cuanto pierde.
    const following = config.martinLevels > 0 && last.phase === 'signal' && last.signal && last.signal.dir;
    if ((scanningNow() || last.phase === 'waiting' || following) && auto && config.region) setTimeout(scanTick, 15);
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
    // Sin el panel no queda nada que ver: se cierra tambien la ventana (oculta) de la fuente interna.
    quitting = true;
    app.quit();
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
  levelHistory.reset();
  levels = null;
  liveClock.reset();
  clockInfo = null;
  missingReads = 0;
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
  feedMap = null; // otra zona: la fuente interna se vuelve a ubicar
  feedPeriod = 0;
  feedMisses = 0;
  feedLastBucket = null;
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
  flushRecord();
  loadConfidenceStats(); // el porcentaje de confianza es por plazo
  loadPatternStats(); // y la estadistica por patron tambien
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
  feedMap = null; // otro par: la fuente interna se vuelve a ubicar
  feedPeriod = 0;
  feedMisses = 0;
  publish();
});

// Dar siempre ARRIBA o ABAJO (true) o permitir ESPERAR cuando no hay lectura clara (false).
ipcMain.on('set-always', (_e, value) => {
  config.alwaysSignal = Boolean(value);
  saveConfig();
  publish();
});

// Seguimiento: cuantas martingalas seguidas se dan cuando una senal pierde (0 = ninguna).
ipcMain.on('set-martin', (_e, value) => {
  const levels = Math.round(Number(value));
  if (!Number.isFinite(levels) || levels < 0 || levels > MARTIN_MAX_LEVELS) return;
  config.martinLevels = levels;
  saveConfig();
  publish();
});

// Bot en DEMO: que el bot abra las operaciones (si su puente esta abierto) o solo marcar la senal.
ipcMain.on('set-auto-trade', (_e, value) => {
  config.autoTrade = Boolean(value);
  saveConfig();
  publish();
});

// La prediccion sale siempre al abrir una vela nueva (true) o en cuanto termina el analisis (false).
ipcMain.on('set-new-candle', (_e, value) => {
  config.newCandle = Boolean(value);
  saveConfig();
  publish();
});

// Dos etapas: segundos de espera de entrada (0 = el plazo cuenta desde que sale la senal).
ipcMain.on('set-entry-wait', (_e, value) => {
  const seconds = Math.round(Number(value));
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) return;
  config.entryWaitSeconds = seconds;
  saveConfig();
  publish();
});

// Vetar (true) o no los patrones con mala estadistica (se siguen midiendo igual).
ipcMain.on('set-pattern-veto', (_e, value) => {
  config.patternVeto = Boolean(value);
  saveConfig();
  publish();
});

// Veto anti-rebote: no dar senal a favor de una vertical recien hecha.
ipcMain.on('set-anti-rebound', (_e, value) => {
  config.antiRebound = Boolean(value);
  saveConfig();
  publish();
});

// Fuente interna de precios y velas (terminal demo). Apagada, todo sale de los pixeles.
ipcMain.on('set-internal-source', (_e, value) => {
  config.internalSource = Boolean(value);
  saveConfig();
  if (config.internalSource) createVisor();
  else closeVisor();
  publish();
});

// Muestra u oculta la ventana de la terminal demo (para elegir ahi el mismo par que se opera).
ipcMain.on('toggle-visor', () => {
  if (!visor || visor.isDestroyed()) {
    if (config.internalSource) createVisor();
    if (!visor) return;
  }
  if (visor.isVisible()) visor.hide();
  else {
    visor.show();
    visor.focus();
  }
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
    await saveScreenPhoto(); // y una foto de la pantalla completa, con el panel encima
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
    loadConfidenceStats();
    loadPatternStats();
    createWindow();
    createVisor(); // fuente interna: terminal demo en una ventana oculta
    setInterval(scanTick, SCAN_INTERVAL_MS);
    setInterval(checkPhotoRequest, 1000);
    setInterval(readVisorPayout, 3000);
    // Estado del bot de Pocket (si esta abierto). Cada cambio queda en el registro:
    //   O,ms,bot,disponible|no disponible,saldo,motivo
    setInterval(() => {
      bot
        .refresh()
        .then((status) => {
          const key = `${status.online}|${status.error || ''}`;
          if (key === botLogged) return;
          botLogged = key;
          record(`O,${Date.now()},bot,${status.online ? 'disponible' : 'no disponible'},${status.balance === null ? '' : status.balance},${String(status.error || '').replace(/[,\r\n]+/g, ' ')}`);
        })
        .catch(() => {});
    }, 2500);
    setInterval(flushRecord, 5000);
    app.on('before-quit', () => {
      quitting = true; // ahora si se cierra la ventana de la fuente interna
    });
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
