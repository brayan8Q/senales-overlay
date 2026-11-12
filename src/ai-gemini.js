/**
 * Opinion de Gemini (API de Google) sobre la grafica. Recibe los mismos numeros
 * que las otras IA (ver ai.js) y responde hacia donde cree que ira el precio.
 *
 * La clave va en la cabecera `x-goog-api-key`, nunca en la direccion.
 * El modelo se elige entre los que la cuenta tiene de verdad (se le pregunta a
 * Google la lista): si hay uno cuyo nombre contenga "argon", ese es el de por defecto.
 */
const { systemPrompt, parseAnswer } = require('./ai');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const KEYS_PAGE = 'https://aistudio.google.com/apikey';
// SENALES_GEMINI_BASE_URL permite a las pruebas apuntar a un servidor falso.
const baseUrl = () => process.env.SENALES_GEMINI_BASE_URL || DEFAULT_BASE_URL;
const PREFERRED = [/argon/i, /pro/i, /flash/i];

/** Error con un mensaje apto para el panel (nunca incluye la clave). */
function apiError(status, bodyText) {
  let detail = '';
  let reason = '';
  try {
    const error = JSON.parse(bodyText).error || {};
    detail = error.message || '';
    reason = JSON.stringify(error.details || '');
  } catch {
    detail = '';
  }
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(detail + reason)) return new Error('La clave no es válida.');
  if (status === 401 || status === 403) return new Error('La clave no es válida o no tiene permiso para usar Gemini.');
  if (status === 404) return new Error('Ese modelo no está disponible en tu cuenta.');
  if (status === 429) return new Error('Sin cuota o demasiadas consultas en tu cuenta de Google.');
  return new Error(`Google respondió ${status}${detail ? `: ${detail.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
}

async function request(url, { key, body, timeoutMs }) {
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('La IA tardó demasiado en responder.');
    throw new Error('No se pudo conectar con Google (revisa tu internet).');
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
    throw new Error('Google respondió algo que no se pudo leer.');
  }
}

/** Lista los modelos de la cuenta que sirven para generar texto. Tambien comprueba la clave. */
async function listModels({ key, timeoutMs = 8000 }) {
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const data = await request(`${baseUrl()}/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { key, timeoutMs });
    for (const model of data.models || []) {
      const methods = model.supportedGenerationMethods || [];
      if (methods.length === 0 || methods.includes('generateContent')) ids.push(String(model.name || '').replace(/^models\//, ''));
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  return ids.filter(Boolean);
}

/** Los que sirven para conversar (se descartan imagen, audio, embeddings, etc.). */
function chatModels(available) {
  return available
    .filter((id) => !/(embedding|imagen|image|tts|audio|aqa|veo|live|robotics|computer-use|learnlm|gemma)/i.test(id))
    .sort();
}

/** Modelo a usar: el que eligio el usuario; si no, uno "argon"; si no, el pro o flash mas nuevo. */
function pickModel(available, preferred = null) {
  if (preferred && available.includes(preferred)) return preferred;
  const chat = chatModels(available);
  for (const pattern of PREFERRED) {
    const found = chat.filter((id) => pattern.test(id)).reverse()[0];
    if (found) return found;
  }
  return chat.reverse()[0] || null;
}

/**
 * Pregunta a Gemini hacia donde ira el precio.
 * @returns {Promise<{dir:'up'|'down'|null, confidence:string, reason:string}>}
 */
async function askDirection({ key, model, snapshot, timeoutMs = 6000, force = false }) {
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(force) }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(snapshot) }] }],
    generationConfig: { responseMimeType: 'application/json' },
  };
  const url = `${baseUrl()}/models/${encodeURIComponent(model)}:generateContent`;
  let data;
  try {
    data = await request(url, { key, body, timeoutMs });
  } catch (err) {
    // Algunos modelos no aceptan pedir la respuesta en JSON: se reintenta una vez sin eso.
    if (err.status !== 400 || /clave/.test(err.message)) throw err;
    delete body.generationConfig;
    data = await request(url, { key, body, timeoutMs });
  }
  const candidate = (data.candidates || [])[0];
  if (!candidate || !candidate.content) {
    const blocked = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(blocked ? 'Gemini declinó responder esta consulta.' : 'Gemini no devolvió respuesta.');
  }
  const text = (candidate.content.parts || []).map((part) => part.text || '').join('');
  // Tokens de esta consulta, tal como los cobra Google (los de "pensamiento" cuentan como salida).
  const used = data.usageMetadata || {};
  return {
    ...parseAnswer(text),
    usage: { input: used.promptTokenCount || 0, output: (used.candidatesTokenCount || 0) + (used.thoughtsTokenCount || 0) },
  };
}

module.exports = { listModels, chatModels, pickModel, askDirection, DEFAULT_BASE_URL, KEYS_PAGE };
