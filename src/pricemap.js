/**
 * Puente entre la FUENTE INTERNA (precios reales) y la pantalla (píxeles).
 *
 * El panel dibuja sobre la gráfica, así que todo lo que calcula vive en "unidades de pantalla"
 * (filas de la imagen, con el signo cambiado: mayor = más alto). Para usar las velas de la
 * fuente interna sin cambiar nada de lo demás, se pasan a esas unidades con una recta:
 *
 *     valor_en_pantalla = A + B × precio
 *
 * La recta se saca comparando las velas cerradas que se ven en la pantalla con las mismas velas
 * de la fuente interna (mínimos cuadrados sobre aperturas, cierres, máximos y mínimos). Si las
 * dos no cuadran (otro par, otra temporalidad, otra gráfica), el error del ajuste es grande y la
 * fuente interna NO se usa: esa comparación es la que evita mezclar datos de gráficas distintas.
 *
 * Al cerrar una vela, la pantalla y la fuente pueden ir una vela desfasadas por un instante; por
 * eso se prueban tres alineaciones (0, +1, -1) y se queda la que mejor ajusta.
 */
const MIN_PAIRS = 5; // velas en común para dar el ajuste por bueno
const MAX_PAIRS = 24;
const MIN_SPAN_PX = 6; // si todas las velas caben en menos de esto, la recta no se puede fijar

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

/**
 * @param {Array} pixel  Velas leídas de la pantalla (la última en curso), en unidades de pantalla.
 * @param {{closed:Array, forming:object}} feed  Velas de la fuente interna, en precios.
 * @returns {{valid:boolean, A:number, B:number, rms:number, n:number, shift:number, tolerance:number}|null}
 *   shift = cuántas velas cerradas de más tiene la fuente respecto a la pantalla (0, 1 o -1).
 */
function fitPriceMap(pixel, feed) {
  if (!pixel || pixel.length < MIN_PAIRS + 1 || !feed || !feed.closed) return null;
  const px = pixel.slice(0, -1);
  const fd = feed.closed;
  const unit = median(px.slice(-20).map((c) => c.high - c.low));
  const tolerance = Math.max(1.5, unit * 0.15);
  let best = null;
  for (const shift of [0, 1, -1]) {
    const points = []; // [precio, valor en pantalla]
    let n = 0;
    for (let k = 0; k < MAX_PAIRS; k++) {
      const p = px[px.length - 1 - (shift < 0 ? k - shift : k)];
      const f = fd[fd.length - 1 - (shift > 0 ? k + shift : k)];
      if (!p || !f) break;
      points.push([f.high, p.high], [f.low, p.low], [f.open, p.open], [f.close, p.close]);
      n++;
    }
    if (n < MIN_PAIRS) continue;
    // Mínimos cuadrados: valor = A + B × precio.
    const count = points.length;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of points) {
      sx += x;
      sy += y;
    }
    const mx = sx / count;
    const my = sy / count;
    let sxx = 0;
    let sxy = 0;
    for (const [x, y] of points) {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (y - my);
    }
    if (!(sxx > 0)) continue;
    const B = sxy / sxx;
    const A = my - B * mx;
    let sum = 0;
    let top = -Infinity;
    let bottom = Infinity;
    for (const [x, y] of points) {
      const d = A + B * x - y;
      sum += d * d;
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
    const rms = Math.sqrt(sum / count);
    const valid = B > 0 && top - bottom >= MIN_SPAN_PX && rms <= tolerance;
    const candidate = { valid, A, B, rms, n, shift, tolerance };
    if (!best || (candidate.valid && !best.valid) || (candidate.valid === best.valid && rms < best.rms)) best = candidate;
  }
  return best;
}

/** Vela de la fuente interna pasada a unidades de pantalla. */
function toScreen(map, candle, geometry = null) {
  const at = (price) => map.A + map.B * price;
  return {
    x0: geometry ? geometry.x0 : null,
    x1: geometry ? geometry.x1 : null,
    dir: candle.close > candle.open ? 'up' : candle.close < candle.open ? 'down' : 'flat',
    open: at(candle.open),
    close: at(candle.close),
    high: at(candle.high),
    low: at(candle.low),
    time: candle.time,
  };
}

module.exports = { fitPriceMap, toScreen, MIN_PAIRS };
