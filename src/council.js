/**
 * Consejo de IAs: varias IA opinan sobre la misma grafica y de sus respuestas
 * sale UNA senal.
 *
 * Reglas:
 *   - Gana el lado con mas votos.
 *   - Empate en votos: gana el lado cuyas IA dijeron estar mas seguras
 *     (alta = 3, media = 2, baja = 1). Si sigue empatado, el consejo no decide
 *     (dir null) y la senal sale de las reglas del panel.
 *   - Confianza del consejo: unanime entre 2 o mas -> "alta"; mayoria con una en
 *     contra -> la de la mayoria bajada un nivel; decidida por desempate -> "baja".
 *     Con una sola IA, vale su propia confianza.
 *
 * Varias IA de acuerdo no es una garantia: todas ven los mismos numeros. Por eso
 * cada una lleva su propio marcador de aciertos.
 */
const PROVIDER_ORDER = ['openai', 'gemini', 'claude'];
const FALLBACK_NAMES = { openai: 'GPT', gemini: 'Gemini', claude: 'Claude' };
const GENERIC = new Set(['gpt', 'gemini', 'claude', 'models', 'preview', 'latest', 'exp', 'experimental', 'chatgpt', 'mini', 'nano', 'lite', 'pro', 'flash']);
const WEIGHT = { alta: 3, media: 2, baja: 1 };
const LOWER = { alta: 'media', media: 'baja', baja: 'baja' };
const ARROW = { up: '▲', down: '▼' };

/** Nombre corto de un modelo: "gpt-6-astra" -> "Astra", "claude-fable-5-2" -> "Fable". */
function nickname(provider, model) {
  const word = String(model || '')
    .toLowerCase()
    .split(/[-_.\s]+/)
    .find((part) => /^[a-z]{3,}$/.test(part) && !GENERIC.has(part));
  return word ? word[0].toUpperCase() + word.slice(1) : FALLBACK_NAMES[provider] || provider;
}

/**
 * @param {Object<string,{dir:'up'|'down'|null, confidence:string, reason:string, name:string}>} answers
 *        Respuesta de cada IA que contesto (por proveedor).
 * @returns {{dir:'up'|'down'|null, confidence:string, reason:string, votes:string, count:number}|null}
 *          null si ninguna IA contesto.
 */
function combine(answers) {
  const list = PROVIDER_ORDER.filter((p) => answers[p]).map((p) => ({ provider: p, ...answers[p] }));
  if (list.length === 0) return null;
  const votes = list.map((a) => `${a.name} ${ARROW[a.dir] || '–'}`).join(' · ');
  const side = (dir) => list.filter((a) => a.dir === dir);
  const up = side('up');
  const down = side('down');
  const weight = (group) => group.reduce((sum, a) => sum + (WEIGHT[a.confidence] || 1), 0);
  const best = (group) => [...group].sort((a, b) => (WEIGHT[b.confidence] || 1) - (WEIGHT[a.confidence] || 1))[0];

  if (up.length === 0 && down.length === 0) {
    return { dir: null, confidence: 'ninguna', reason: `${votes}. Ninguna IA eligió un lado.`, votes, count: list.length };
  }
  let winners;
  let confidence;
  if (up.length !== down.length) {
    winners = up.length > down.length ? up : down;
    const losers = up.length > down.length ? down : up;
    const top = best(winners).confidence;
    if (list.length === 1) confidence = top;
    else if (losers.length === 0 && winners.length >= 2) confidence = 'alta';
    else if (losers.length === 0) confidence = top; // las demas no eligieron lado
    else confidence = LOWER[top] || 'baja';
  } else if (weight(up) !== weight(down)) {
    winners = weight(up) > weight(down) ? up : down;
    confidence = 'baja';
  } else {
    return { dir: null, confidence: 'ninguna', reason: `${votes}. Empate entre las IA.`, votes, count: list.length };
  }
  const lead = best(winners);
  const said = String(lead.reason || '').replace(/^IA:\s*/, '');
  // Con una sola IA basta su explicacion; con varias, primero los votos y luego quien lo explica.
  const reason = list.length > 1 ? `${votes}. ${lead.name}: ${said}` : said;
  return { dir: lead.dir, confidence, reason, votes, count: list.length };
}

/**
 * Anota en el marcador de cada IA si acerto. `actual` = hacia donde fue el precio de verdad.
 * @param {Object<string,{wins:number,losses:number}>} scores  Se modifica.
 * @param {Object<string,'up'|'down'|null>} voted  Lo que dijo cada IA para esa senal.
 */
function scoreVotes(scores, voted, actual) {
  if (actual !== 'up' && actual !== 'down') return;
  for (const [provider, dir] of Object.entries(voted || {})) {
    if (dir !== 'up' && dir !== 'down') continue;
    const score = (scores[provider] = scores[provider] || { wins: 0, losses: 0 });
    if (dir === actual) score.wins++;
    else score.losses++;
  }
}

const MEMORY = 10; // predicciones recientes que se le recuerdan a cada IA
const WORD = { up: 'subiria', down: 'bajaria' };
const DID = { up: 'subio', down: 'bajo' };

/**
 * Guarda, para cada IA, lo que predijo y lo que paso de verdad. Las IA no recuerdan nada entre
 * una consulta y la siguiente; esto es lo que luego se les manda para que puedan corregirse.
 * @param {Object<string,Array>} memory   Se modifica: por IA, lista de { said, happened, reason }.
 * @param {Object<string,{dir:string|null, reason:string}>} answers  Lo que contesto cada IA.
 * @param {'up'|'down'|null} actual       Hacia donde fue el precio (null = no se pudo medir).
 */
function rememberOutcome(memory, answers, actual) {
  if (actual !== 'up' && actual !== 'down') return;
  for (const [provider, answer] of Object.entries(answers || {})) {
    if (!answer || (answer.dir !== 'up' && answer.dir !== 'down')) continue;
    const list = (memory[provider] = memory[provider] || []);
    list.push({ said: answer.dir, happened: actual, reason: String(answer.reason || '').slice(0, 80) });
    if (list.length > MEMORY) list.splice(0, list.length - MEMORY);
  }
}

/**
 * Lo que se le manda a una IA sobre sus propias predicciones anteriores en esta grafica.
 * @returns {object|null}  null si todavia no hay ninguna medida.
 */
function feedbackFor(list) {
  if (!list || list.length === 0) return null;
  const hits = list.filter((e) => e.said === e.happened).length;
  return {
    explicacion:
      'tus predicciones anteriores en esta misma grafica y lo que hizo el precio despues, de la mas vieja a la mas reciente. ' +
      'No recuerdas nada entre consultas: esto es todo lo que sabes de como te ha ido',
    aciertos: `${hits} de ${list.length}`,
    lista: list.map((e) => ({ dijiste: WORD[e.said], paso: DID[e.happened], acertaste: e.said === e.happened, tu_razon: e.reason })),
  };
}

module.exports = { combine, nickname, scoreVotes, rememberOutcome, feedbackFor, PROVIDER_ORDER };
