/**
 * Patron medido: en ESTA grafica y a ESTE plazo, ¿el precio tiende a continuar o a rebotar?
 *
 * La simulacion (tools/simular.js) mostro que las reglas del panel aciertan cuando el
 * mercado continua lo que venia haciendo y fallan cuando rebota. Cual de las dos cosas
 * pasa no se puede saber de antemano: hay que medirlo en el precio real.
 *
 * Como se mide: se corta el recorrido reciente del precio en tramos del tamano del plazo
 * (5 s si las senales son a 5 s). Para cada par de tramos seguidos se anota si el segundo
 * fue hacia el mismo lado que el primero (continuo) o hacia el contrario (reboto).
 *
 *   - Si continua claramente mas de la mitad de las veces -> 'continua'.
 *   - Si rebota claramente mas de la mitad -> 'rebota'.
 *   - Si no se distingue del azar -> null (no se toca la senal).
 *
 * "Claramente" = a 2 desviaciones o mas de 50 % (z >= 2), con al menos 60 pares.
 * No es una garantia: describe los ultimos minutos y puede cambiar.
 */
const MIN_PAIRS = 24; // 2 minutos a 5 s: suficiente para empezar; z >= 2 exige que sea claro
const Z_NEEDED = 2;
const Z_STRONG = 3;
const NEAR_MS = 450; // una lectura sirve para un instante si esta a menos de esto

/** Valor del precio en el instante `time` (la lectura mas cercana), o null si no hay ninguna cerca. */
function valueAt(prices, time) {
  let lo = 0;
  let hi = prices.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  let best = prices[lo];
  if (lo > 0 && Math.abs(prices[lo - 1].time - time) < Math.abs(best.time - time)) best = prices[lo - 1];
  return Math.abs(best.time - time) <= NEAR_MS ? best.value : null;
}

/**
 * @param {Array<{time:number,value:number}>} prices  Recorrido del precio, ordenado por tiempo (mayor = mas alto).
 * @param {number} horizonMs  Plazo de la senal.
 * @param {number} now
 * @returns {{ kind:'continua'|'rebota'|null, rate:number|null, pairs:number, z:number,
 *             lastMove:number, vote:number, text:string }}
 *   rate = % de veces que continuo. vote = votos hacia arriba (+) o abajo (-) para la proxima senal.
 */
function measureRegime(prices, horizonMs, now) {
  const empty = { kind: null, rate: null, pairs: 0, z: 0, lastMove: 0, vote: 0, text: 'midiendo…' };
  if (!prices.length || horizonMs <= 0) return empty;
  const first = prices[0].time;
  // Movimiento de cada tramo, del mas reciente hacia atras.
  const moves = [];
  for (let end = now; end - horizonMs >= first; end -= horizonMs) {
    const a = valueAt(prices, end - horizonMs);
    const b = valueAt(prices, end);
    moves.push(a === null || b === null ? null : Math.sign(b - a));
  }
  let pairs = 0;
  let continued = 0;
  for (let i = 0; i + 1 < moves.length; i++) {
    const later = moves[i];
    const earlier = moves[i + 1];
    if (!later || !earlier) continue; // sin dato o sin movimiento
    pairs++;
    if (later === earlier) continued++;
  }
  const lastMove = moves.length && moves[0] ? moves[0] : 0;
  if (pairs < MIN_PAIRS) {
    return { ...empty, pairs, lastMove, text: `midiendo… (${pairs} de ${MIN_PAIRS} tramos)` };
  }
  const rate = (100 * continued) / pairs;
  const z = (continued - pairs / 2) / Math.sqrt(pairs / 4);
  let kind = null;
  if (z >= Z_NEEDED) kind = 'continua';
  else if (z <= -Z_NEEDED) kind = 'rebota';
  const weight = Math.abs(z) >= Z_STRONG ? 3 : 2;
  const vote = kind && lastMove ? (kind === 'continua' ? 1 : -1) * lastMove * weight : 0;
  const shown = kind === 'rebota' ? 100 - rate : rate;
  const text = kind
    ? `${kind === 'continua' ? 'continúa' : 'rebota'} ${shown.toFixed(0)} % (${pairs} tramos)`
    : `sin patrón claro (${rate.toFixed(0)} % continúa, ${pairs} tramos)`;
  return { kind, rate, pairs, z, lastMove, vote, text };
}

module.exports = { measureRegime, valueAt, MIN_PAIRS };
