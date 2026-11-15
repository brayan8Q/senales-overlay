/**
 * ANTI-REBOTE EN EXTREMOS (15 nov 2026).
 *
 * Una "vertical" son 2 o más velas seguidas del mismo color, cada una con cuerpo grande (1.5
 * veces o más el cuerpo promedio de las últimas 20 velas cerradas), que además marcaron un
 * extremo nuevo: el máximo (si suben) o el mínimo (si bajan) de las últimas 20 velas.
 *
 * Regla: justo después de una vertical NO se entra en su misma dirección, aunque la señal y
 * las IA lo digan: ahí es donde el precio suele devolver parte del recorrido.
 *
 * Excepción (estructura de continuación): sí se permite cuando, después de la vertical,
 *   - hay una BASE de 3 o más velas cerradas, estrecha (no mide más que la mitad de la
 *     vertical), y el precio ya rompió esa base hacia el lado de la vertical; o
 *   - hubo un RETROCESO SUPERFICIAL (menos del 38 % de la vertical) que sostuvo, y la última
 *     vela cerrada es de confirmación: del color de la vertical y cerrando más allá del
 *     extremo de la vela anterior.
 * La regla deja de aplicar si el precio ya devolvió 38 % o más (entrar ahí ya no es perseguir
 * la vertical) o si pasaron más de 6 velas cerradas desde ella.
 *
 * Todo se mide en las unidades de las velas (da igual si son píxeles o precios): son proporciones.
 * Aviso honesto: estos números (1.5, 20, 38 %, 3 velas) son los que pidió la regla; que la
 * regla ayude o no se mide con el registro (líneas "P" con tipo veto-rebote), no se da por hecho.
 */
const LOOKBACK = 20; // velas con las que se compara: cuerpo promedio y extremo
const BIG_BODY = 1.5; // cuerpo grande: estas veces el cuerpo promedio
const MIN_RUN = 2; // velas grandes seguidas del mismo color
const MIN_HISTORY = 8; // velas cerradas antes de la vertical, para poder comparar
const MAX_AFTER = 6; // velas cerradas después de la vertical en las que la regla sigue viva
const SHALLOW = 0.38; // retroceso superficial: menos de esta parte de la vertical
const BASE_MIN = 3; // velas de la base
const BASE_MAX_HEIGHT = 0.5; // la base mide como mucho esta parte de la vertical

const body = (c) => Math.abs(c.close - c.open);
const colorOf = (c) => (c.dir === 'up' || c.dir === 'down' ? c.dir : c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat');
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Busca la vertical más reciente.
 * @param {Array} candles  Velas, la última en curso.
 * @returns {null|{dir:'up'|'down', start:number, end:number, length:number, includesForming:boolean,
 *   base:number, extreme:number, height:number, ratios:number[], avgBody:number, after:Array}}
 *   start/end = índices en `candles`; after = velas CERRADAS posteriores a la vertical.
 */
function findVertical(candles) {
  if (!candles || candles.length < MIN_HISTORY + MIN_RUN + 1) return null;
  const last = candles.length - 1; // la vela en curso
  const closedCount = last;
  // Cuerpo promedio de las 20 velas cerradas que terminan en `index` (o en la última cerrada).
  const avgBodyAt = (index) => {
    const end = Math.min(index, closedCount - 1);
    const from = Math.max(0, end - LOOKBACK + 1);
    let sum = 0;
    for (let i = from; i <= end; i++) sum += body(candles[i]);
    return end >= from ? sum / (end - from + 1) : 0;
  };
  const ratioAt = (index) => {
    const avg = avgBodyAt(index);
    return avg > 0 ? body(candles[index]) / avg : 0;
  };
  const isBig = (index) => ratioAt(index) >= BIG_BODY;

  for (let end = last; end >= Math.max(MIN_HISTORY + MIN_RUN - 1, last - MAX_AFTER - 1); end--) {
    const dir = colorOf(candles[end]);
    if (dir === 'flat' || !isBig(end)) continue;
    let start = end;
    while (start - 1 >= 0 && colorOf(candles[start - 1]) === dir && isBig(start - 1)) start--;
    const length = end - start + 1;
    if (length < MIN_RUN || start < MIN_HISTORY) continue;
    // Extremo nuevo: lo más alto (o lo más bajo) de las 20 velas anteriores a la vertical.
    const before = candles.slice(Math.max(0, start - LOOKBACK), start);
    const run = candles.slice(start, end + 1);
    const up = dir === 'up';
    const extreme = up ? Math.max(...run.map((c) => c.high)) : Math.min(...run.map((c) => c.low));
    const previous = up ? Math.max(...before.map((c) => c.high)) : Math.min(...before.map((c) => c.low));
    if (up ? extreme < previous : extreme > previous) continue;
    const base = candles[start].open;
    const height = Math.abs(extreme - base);
    if (!(height > 0)) continue;
    return {
      dir,
      start,
      end,
      length,
      includesForming: end === last,
      base,
      extreme,
      height,
      ratios: run.map((_, i) => round1(ratioAt(start + i))),
      avgBody: avgBodyAt(end),
      after: candles.slice(end + 1, last),
    };
  }
  return null;
}

/**
 * ¿Se veta una señal hacia `dir`?
 * @returns {{veto:boolean, allowed:null|'base'|'pullback'|'profundo', reason:string, data:object|null, vertical:object|null}}
 */
function antiRebound({ candles, dir }) {
  const vertical = findVertical(candles);
  const none = { veto: false, allowed: null, reason: '', data: null, vertical };
  if (!vertical || !dir || vertical.dir !== dir) return none;
  const up = dir === 'up';
  const sign = up ? 1 : -1;
  const forming = candles[candles.length - 1];
  const after = vertical.after;
  // Lo que vino después de la vertical (velas cerradas y la vela en curso, si no es parte de ella).
  const tail = vertical.includesForming ? [] : [...after, forming];
  const peak = tail.length ? (up ? Math.max(vertical.extreme, ...tail.map((c) => c.high)) : Math.min(vertical.extreme, ...tail.map((c) => c.low))) : vertical.extreme;
  const worst = tail.length ? (up ? Math.min(...tail.map((c) => c.low)) : Math.max(...tail.map((c) => c.high))) : peak;
  const height = Math.abs(peak - vertical.base) || vertical.height;
  const retrace = Math.max(0, (peak - worst) * sign) / height;
  const data = {
    lado: dir,
    velas: vertical.length,
    cuerpos: vertical.ratios, // veces el cuerpo promedio
    extremo: up ? 'máximo' : 'mínimo',
    despues: after.length, // velas cerradas después de la vertical
    retroceso: Math.round(retrace * 100), // % de la vertical ya devuelto
  };
  const color = up ? 'verdes' : 'rojas';
  const head = `${vertical.length} velas ${color} grandes seguidas (${vertical.ratios.join(' y ')} veces el cuerpo normal) marcaron ${data.extremo} de ${LOOKBACK} velas`;

  if (retrace >= SHALLOW) {
    return { veto: false, allowed: 'profundo', reason: `${head}, pero el precio ya devolvió ${data.retroceso} %: no es perseguir la vertical.`, data, vertical };
  }
  // Base: 3+ velas cerradas, estrecha, y el precio ya la rompió hacia el lado de la vertical.
  const breaks = (baseCandles, price) => {
    if (baseCandles.length < BASE_MIN) return false;
    const top = Math.max(...baseCandles.map((c) => c.high));
    const bottom = Math.min(...baseCandles.map((c) => c.low));
    if (top - bottom > BASE_MAX_HEIGHT * height) return false;
    return up ? price > top : price < bottom;
  };
  if (after.length && (breaks(after, forming.close) || breaks(after.slice(0, -1), after[after.length - 1].close))) {
    return { veto: false, allowed: 'base', reason: `${head}; después hizo una base de ${after.length} velas y ya la rompió: continuación.`, data, vertical };
  }
  // Retroceso superficial que sostuvo + vela de confirmación.
  if (after.length >= 2) {
    const lastClosed = after[after.length - 1];
    const previous = after[after.length - 2];
    const pulled = after.slice(0, -1).some((c) => colorOf(c) !== dir && colorOf(c) !== 'flat');
    const confirmed = colorOf(lastClosed) === dir && (up ? lastClosed.close > previous.high : lastClosed.close < previous.low);
    if (pulled && confirmed) {
      return { veto: false, allowed: 'pullback', reason: `${head}; retrocedió solo ${data.retroceso} % y la última vela confirmó: continuación.`, data, vertical };
    }
  }
  const lado = up ? 'ARRIBA' : 'ABAJO';
  const wait = after.length ? 'todavía no hay base ni retroceso confirmado' : 'la vertical acaba de hacerse';
  return {
    veto: true,
    allowed: null,
    reason: `Veto anti-rebote: ${head}; ${wait}. No se entra ${lado} en la misma dirección: ahí suele venir el rebote.`,
    data,
    vertical,
  };
}

module.exports = { findVertical, antiRebound, LOOKBACK, BIG_BODY, MIN_RUN, MAX_AFTER, SHALLOW, BASE_MIN };
