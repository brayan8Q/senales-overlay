/**
 * Precios de las IA, en dolares por millon de tokens [entrada, salida], para estimar
 * cuanto cuesta cada prediccion. Los tokens SI son exactos (los informa cada proveedor en
 * su respuesta); el precio es una referencia y puede cambiar: el dato firme es la factura
 * de cada cuenta.
 *
 * Fuentes (consultadas el 2026-11-12):
 *   - Claude: tabla de precios de Anthropic.
 *   - GPT-6 Astra: 10 / 50 segun la mayoria de las fuentes (una lista 5 / 25).
 *   - Gemini 4 Argon: 2 / 10 de lanzamiento hasta el 2026-11-30; 4 / 20 desde el 2026-12-01.
 * Los tokens "de pensamiento" de cada modelo se cobran como salida.
 */
const PRICES = {
  'claude-fable-5-2': [8, 40],
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'gpt-6-astra': [10, 50],
  'gemini-4-argon': [2, 10],
};
const ARGON_PRICE_CHANGE = Date.UTC(2026, 11, 1); // 1 de diciembre de 2026

/** Precio [entrada, salida] por millon de tokens de un modelo, o null si no se conoce. */
function priceOf(model, now = Date.now()) {
  if (model === 'gemini-4-argon' && now >= ARGON_PRICE_CHANGE) return [4, 20];
  return PRICES[model] || null;
}

/** Costo en dolares de un uso { input, output } en tokens, o null si no se conoce el precio. */
function costOf(model, usage, now = Date.now()) {
  const price = priceOf(model, now);
  if (!price || !usage) return null;
  return (usage.input * price[0] + usage.output * price[1]) / 1e6;
}

module.exports = { priceOf, costOf, PRICES };
