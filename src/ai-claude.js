/**
 * Opinion de Claude (API de Anthropic) sobre la grafica, con la libreria oficial
 * @anthropic-ai/sdk. Recibe los mismos numeros que las otras IA (ver ai.js) y
 * responde hacia donde cree que ira el precio.
 *
 * Notas sobre Claude Fable 5.2 (el modelo por defecto aqui):
 *   - Siempre "piensa": no se manda el parametro `thinking`. Cuanto piensa se regula
 *     con `output_config.effort`; aqui va en "low" porque la senal dura segundos.
 *   - Puede declinar una consulta (stop_reason "refusal"). Se activa el respaldo del
 *     servidor (`fallbacks: "default"`): si declina, otro modelo de Claude contesta
 *     dentro de la misma llamada. Si aun asi declina, esa senal sale sin Claude.
 *   - La cuenta necesita retencion de datos de 30 dias (no funciona con "zero data
 *     retention").
 */
const Anthropic = require('@anthropic-ai/sdk');
const { systemPrompt, parseAnswer } = require('./ai');

const DEFAULT_MODEL = 'claude-fable-5-2';
const KEYS_PAGE = 'https://platform.claude.com/settings/keys';
// La direccion se fija aqui a proposito: si se dejara sin poner, la libreria usaria la variable de
// entorno ANTHROPIC_BASE_URL (si existe) y la clave del usuario podria acabar en otro servidor.
// SENALES_CLAUDE_BASE_URL permite a las pruebas apuntar a un servidor falso.
const API_URL = 'https://api.anthropic.com';
const baseURL = () => process.env.SENALES_CLAUDE_BASE_URL || API_URL;
// Modelos que aceptan el respaldo del servidor ante una negativa.
const SUPPORTS_FALLBACKS = /^claude-(fable-5|opus-5|sonnet-5-5)/;

/** Los reintentos se desactivan: la senal tiene un plazo y un reintento lo pasaria. */
const client = (key) => new Anthropic({ apiKey: key, maxRetries: 0, baseURL: baseURL() });

/** Mensaje apto para el panel (nunca incluye la clave). De lo mas especifico a lo mas general. */
function friendly(error) {
  if (error instanceof Anthropic.AuthenticationError) return new Error('La clave no es válida o fue revocada.');
  if (error instanceof Anthropic.PermissionDeniedError) return new Error('Tu cuenta no tiene acceso a ese modelo.');
  if (error instanceof Anthropic.NotFoundError) return new Error('Ese modelo no está disponible en tu cuenta.');
  if (error instanceof Anthropic.RateLimitError) return new Error('Demasiadas consultas o sin saldo en tu cuenta de Anthropic.');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new Error('La IA tardó demasiado en responder.');
  if (error instanceof Anthropic.APIConnectionError) return new Error('No se pudo conectar con Anthropic (revisa tu internet).');
  if (error instanceof Anthropic.APIError) {
    const detail = String(error.message || '').replace(/\s+/g, ' ').slice(0, 120);
    return new Error(`Anthropic respondió ${error.status || 'un error'}${detail ? `: ${detail}` : ''}`);
  }
  return error;
}

/** Lista los modelos de la cuenta. Sirve tambien para comprobar que la clave funciona. */
async function listModels({ key, timeoutMs = 8000 }) {
  try {
    const ids = [];
    for await (const model of client(key).models.list({}, { timeout: timeoutMs })) ids.push(model.id);
    return ids;
  } catch (error) {
    throw friendly(error);
  }
}

const chatModels = (available) => available.filter((id) => id.startsWith('claude-')).sort();

/** Modelo a usar: el que eligio el usuario, o Claude Fable 5.2, o el mejor que tenga la cuenta. */
function pickModel(available, preferred = null) {
  if (preferred && available.includes(preferred)) return preferred;
  if (available.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  for (const family of ['fable', 'opus', 'sonnet', 'haiku']) {
    const found = chatModels(available)
      .filter((id) => id.includes(family))
      .reverse()[0];
    if (found) return found;
  }
  return null;
}

/**
 * Pregunta a Claude hacia donde ira el precio.
 * @returns {Promise<{dir:'up'|'down'|null, confidence:string, reason:string}>}
 */
async function askDirection({ key, model = DEFAULT_MODEL, snapshot, timeoutMs = 6000, force = false }) {
  const api = client(key);
  const base = {
    model,
    max_tokens: 16000,
    system: `${systemPrompt(force)} Responde únicamente con el JSON, sin texto antes ni después.`,
    messages: [{ role: 'user', content: JSON.stringify(snapshot) }],
  };
  let response;
  try {
    if (SUPPORTS_FALLBACKS.test(model)) {
      response = await api.beta.messages.create(
        {
          ...base,
          output_config: { effort: 'low' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { timeout: timeoutMs },
      );
    } else {
      response = await api.messages.create(base, { timeout: timeoutMs });
    }
  } catch (error) {
    throw friendly(error);
  }
  // Antes de leer el contenido: una negativa llega como respuesta normal (HTTP 200).
  if (response.stop_reason === 'refusal') throw new Error('Claude declinó responder esta consulta.');
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  // Tokens de esta consulta, tal como los cobra Anthropic (el pensamiento va en la salida).
  const used = response.usage || {};
  return {
    ...parseAnswer(text),
    usage: {
      input: (used.input_tokens || 0) + (used.cache_creation_input_tokens || 0) + (used.cache_read_input_tokens || 0),
      output: used.output_tokens || 0,
    },
  };
}

module.exports = { listModels, chatModels, pickModel, askDirection, friendly, DEFAULT_MODEL, KEYS_PAGE };
