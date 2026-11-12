/**
 * Opinion de una IA (API de OpenAI / ChatGPT) sobre la grafica.
 *
 * Se le mandan SOLO numeros de las velas (forma relativa, sin precios reales ni
 * datos personales) y responde hacia donde cree que ira el precio. Es opcional:
 * si no hay clave, falla o tarda, el panel sigue con sus reglas.
 *
 * Importante: una IA describe patrones mejor que unas reglas fijas, pero eso no
 * la vuelve adivina. Por eso su senal se mide con el mismo marcador.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const KEYS_PAGE = 'https://platform.openai.com/api-keys';
// Modelo por defecto al pegar una clave: el primero de esta lista que la cuenta tenga.
// Criterio: que conteste dentro de la pausa de analisis. Medido el 2026-11-11 con la
// pregunta real del panel: gpt-6-sol ~2 s, gpt-5.5 ~3 s. gpt-5-mini tardo 8-9 s (no sirve).
// El usuario puede elegir cualquier otro modelo de su cuenta en los ajustes.
const PREFERRED_MODELS = ['gpt-6-sol', 'gpt-5.5', 'gpt-4.1-mini', 'gpt-4o-mini'];
const CANDLES_SENT = 12; // pocas velas: el foco es la vela en curso y lo ultimo que hizo el precio

/** Error con un mensaje apto para mostrar en el panel (nunca incluye la clave). */
function apiError(status, bodyText) {
  let detail = '';
  try {
    detail = JSON.parse(bodyText).error.message || '';
  } catch {
    detail = '';
  }
  if (status === 401) return new Error('La clave no es válida o fue revocada.');
  if (status === 429) return new Error('Sin saldo o demasiadas consultas en tu cuenta de OpenAI.');
  if (status === 404) return new Error('Ese modelo no está disponible en tu cuenta.');
  return new Error(`OpenAI respondió ${status}${detail ? `: ${detail.slice(0, 120)}` : ''}`);
}

async function request(url, { key, body, timeoutMs }) {
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('La IA tardó demasiado en responder.');
    throw new Error('No se pudo conectar con OpenAI (revisa tu internet).');
  }
  const text = await response.text();
  if (!response.ok) {
    const error = apiError(response.status, text);
    error.status = response.status;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('OpenAI respondió algo que no se pudo leer.');
  }
}

/** Lista los modelos de la cuenta. Sirve tambien para comprobar que la clave funciona. */
async function listModels({ baseUrl = DEFAULT_BASE_URL, key, timeoutMs = 8000 }) {
  const data = await request(`${baseUrl}/models`, { key, timeoutMs });
  return (data.data || []).map((m) => m.id);
}

/** De todos los modelos de la cuenta, los que sirven para conversar (se descartan audio, imagen, etc.). */
function chatModels(available) {
  return available
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
    .filter((id) => !/(audio|realtime|image|tts|transcribe|search|embedding|moderation|instruct)/.test(id))
    .sort();
}

/** Elige un modelo de chat economico entre los que tiene la cuenta. */
function pickModel(available, preferred = null) {
  if (preferred && available.includes(preferred)) return preferred;
  for (const id of PREFERRED_MODELS) if (available.includes(id)) return id;
  const chat = chatModels(available).filter((id) => id.startsWith('gpt-'));
  const mini = chat.filter((id) => id.includes('mini')).reverse();
  return mini[0] || chat.reverse()[0] || null;
}

/**
 * Resume la grafica en numeros pequenos: cada vela como [apertura, maximo, minimo, cierre],
 * en una escala donde una vela tipica mide ~100 y la primera abre en 0.
 */
function describeChart(candles, moves, seconds, { asset = '', ticks = [], readings = null, now = null, price = null, regime = null, memory = null } = {}) {
  const recent = candles.slice(-CANDLES_SENT);
  const ranges = recent.map((c) => c.high - c.low).sort((a, b) => a - b);
  const typical = ranges[Math.floor((ranges.length - 1) / 2)] || 1;
  const base = recent[0].open;
  const scale = (v) => Math.round(((v - base) * 100) / typical);
  const rows = recent.map((c) => [scale(c.open), scale(c.high), scale(c.low), scale(c.close)]);
  const snapshot = {
    formato: '[apertura, maximo, minimo, cierre]; numero mayor = precio mas alto; una vela tipica mide ~100',
    velas_cerradas: rows.slice(0, -1),
    vela_en_curso: rows[rows.length - 1],
    movimientos_recientes_del_precio: moves.map((m) => (m === 'up' ? 'subio' : m === 'down' ? 'bajo' : 'quieto')),
    segundos_a_predecir: seconds,
  };
  // Como se mueve el precio dentro de la vela en curso, lectura a lectura (misma escala que las velas).
  if (ticks.length >= 3) {
    const first = ticks[0];
    snapshot.precio_ultimos_segundos = {
      explicacion: 'recorrido del precio lectura a lectura, la mas reciente al final; positivo = por encima de la primera',
      segundos_que_abarca: Math.round((ticks[ticks.length - 1].time - first.time) / 100) / 10,
      recorrido: ticks.map((t) => Math.round(((first.y - t.y) * 100) / typical)),
    };
  }
  // Lo que el panel ve en este instante: subiendo, bajando, giro desde el pico, perdiendo fuerza...
  if (now && now.text && now.text !== 'sin lecturas') snapshot.precio_ahora_mismo = now.text;
  // Cotizacion leida del eje de la grafica (si el eje esta a la vista).
  if (price) snapshot.cotizacion_actual = price;
  // Lo unico MEDIDO sobre como se comporta este precio: tras un tramo del plazo indicado,
  // cuantas veces el tramo siguiente fue hacia el mismo lado.
  if (regime && regime.pairs) {
    snapshot.patron_medido = {
      explicacion: 'medido en esta grafica en los ultimos minutos, con tramos del mismo plazo que se pide predecir',
      tipo: regime.kind || 'sin patron claro',
      porcentaje_de_veces_que_continuo: Math.round(regime.rate),
      tramos_medidos: regime.pairs,
      ultimo_tramo: regime.lastMove > 0 ? 'subio' : regime.lastMove < 0 ? 'bajo' : 'quieto',
    };
  }
  // Las 8 lecturas del panel, calculadas con un historial mas largo que las velas enviadas.
  if (readings) {
    snapshot.lecturas = {
      explicacion:
        'calculadas sobre el historial acumulado; distancias y avances en "velas" (1 = tamano de una vela tipica); ' +
        'up = hacia arriba, down = hacia abajo, flat = de lado',
      ...readings,
    };
  }
  // Memoria del mercado: lo que paso otras veces en esta grafica tras una situacion como la actual.
  if (memory && memory.velas_guardadas) snapshot.memoria_del_mercado = memory;
  const name = String(asset || '').trim().slice(0, 60);
  if (name) snapshot.activo = name;
  return snapshot;
}

const PROMPT_INTRO =
  'Eres un trader experto en operaciones de muy corto plazo: dominas las velas japonesas, el análisis ' +
  'técnico, la lectura de tendencia y la acción del precio (momentum, agotamiento, rechazos, soportes y ' +
  'resistencias). Tu foco es la vela en curso y lo que el precio hace en este instante; las velas ' +
  'anteriores son solo contexto. Recibes las velas recientes de una gráfica, con la vela ' +
  'en curso al final, y los últimos movimientos del precio (el más reciente al final). Decide hacia dónde ' +
  'es más probable que esté el precio, respecto a ahora, pasados los segundos indicados. Fíjate en la ' +
  'tendencia, el tamaño de los cuerpos, las mechas (rechazos), velas envolventes y si la vela en curso ya ' +
  'está muy extendida. Dale el mayor peso a lo más reciente: la vela en curso y, si viene, el recorrido ' +
  'del precio en los últimos segundos (si acelera, frena o se da la vuelta). Si vienen "lecturas" (tendencia ' +
  'larga, cruce de medias EMA, momentum, RSI, movimiento del último minuto, soporte por debajo y resistencia ' +
  'por encima), analízalas todas como contexto: si lo reciente va a favor de ellas la lectura es más clara; ' +
  'si va en contra, o el precio está pegado a un soporte o resistencia, o el RSI está en un extremo, tenlo en ' +
  'cuenta y baja la confianza. No des por hecho que un movimiento continúa solo porque viene ocurriendo: ' +
  'busca agotamiento (vela en curso ya muy extendida, mecha creciendo en el extremo, precio en el máximo o ' +
  'mínimo de lo visto, RSI extremo, racha larga de velas del mismo color, recorrido reciente que frena o ' +
  'gira) y, si lo hay, considera el regreso. La orden se coloca en el instante en que respondes: predice ' +
  'desde el último dato, no desde el promedio. Si viene "patron_medido", dale mucho peso: es lo único medido ' +
  'sobre cómo se comporta este precio a este plazo. Con tipo "continua", lo más probable es que el precio ' +
  'siga la dirección del último tramo; con "rebota", que vaya en contra del último tramo; con "sin patron ' +
  'claro", no lo uses. Si viene "memoria_del_mercado" (cómo se comportó esta gráfica antes: tras una racha ' +
  'de velas como la actual, cuántas veces la siguiente siguió igual o giró), aplícala: es historia real de ' +
  'este activo. Pesa más cuantos más casos tenga; con menos de 12 casos no saques conclusiones de ella. ' +
  'Si viene "tu_respuesta_tarda", tenlo en cuenta: los datos son de ahora, pero la operación se abrirá esos ' +
  'segundos después; lo que importa es hacia dónde irá el precio a partir de entonces. ' +
  'Si viene "tus_ultimas_predicciones" (lo que predijiste antes en esta misma gráfica ' +
  'y lo que pasó), úsalo para corregirte: si vienes fallando hacia el mismo lado o con el mismo ' +
  'razonamiento, cámbialo; si vienes acertando, mantén el criterio. No lo uses para adivinar rachas ("ya ' +
  'toca que suba"). Si se indica el activo, úsalo ' +
  'solo como contexto (OTC significa cotización propia del bróker); no supongas noticias ni datos externos. ';
const PROMPT_TAIL =
  '"confidence" dice qué tan clara es la lectura. "reason" va en español, máximo 18 palabras, nombrando lo que viste.';

/** Instrucciones para el modelo. Con `force` debe elegir siempre un lado (sin "wait"). */
function systemPrompt(force) {
  if (force) {
    return (
      PROMPT_INTRO +
      'Responde SOLO un JSON así: {"dir":"up"|"down","confidence":"alta"|"media"|"baja","reason":"..."}. ' +
      'Debes elegir siempre "up" o "down"; si la lectura no es clara, elige el lado más probable y pon ' +
      '"confidence":"baja". ' +
      PROMPT_TAIL
    );
  }
  return (
    PROMPT_INTRO +
    'Responde SOLO un JSON así: {"dir":"up"|"down"|"wait","confidence":"alta"|"media"|"baja","reason":"..."}. ' +
    'Usa "wait" cuando no haya una lectura clara. ' +
    PROMPT_TAIL
  );
}

/** Extrae { dir, reason } del texto del modelo; cualquier cosa rara se toma como "wait". */
function parseAnswer(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { dir: null, confidence: 'ninguna', reason: 'La IA no dio una respuesta clara.' };
  }
  const raw = String(parsed.dir || '').toLowerCase();
  const dir = raw === 'up' ? 'up' : raw === 'down' ? 'down' : null;
  const reason = String(parsed.reason || '').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Sin explicación.';
  const level = String(parsed.confidence || '').toLowerCase();
  const confidence = !dir ? 'ninguna' : ['alta', 'media', 'baja'].includes(level) ? level : 'media';
  return { dir, confidence, reason };
}

/**
 * Pregunta a la IA hacia donde ira el precio.
 * @param {boolean} [options.force]  Pedirle que elija siempre un lado (sin "esperar").
 * @returns {Promise<{dir:'up'|'down'|null, confidence:string, reason:string}>}
 */
async function askDirection({ baseUrl = DEFAULT_BASE_URL, key, model, snapshot, timeoutMs = 6000, force = false }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(force) },
      { role: 'user', content: JSON.stringify(snapshot) },
    ],
    response_format: { type: 'json_object' },
  };
  let data;
  try {
    data = await request(`${baseUrl}/chat/completions`, { key, body, timeoutMs });
  } catch (err) {
    // Algunos modelos no aceptan response_format: se reintenta una vez sin el.
    if (err.status !== 400) throw err;
    delete body.response_format;
    data = await request(`${baseUrl}/chat/completions`, { key, body, timeoutMs });
  }
  const text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  // Tokens de esta consulta, tal como los cobra OpenAI (los de razonamiento van en la salida).
  const used = data.usage || {};
  return { ...parseAnswer(text), usage: { input: used.prompt_tokens || 0, output: used.completion_tokens || 0 } };
}

module.exports = {
  listModels,
  pickModel,
  chatModels,
  describeChart,
  askDirection,
  parseAnswer,
  systemPrompt,
  DEFAULT_BASE_URL,
  KEYS_PAGE,
};
