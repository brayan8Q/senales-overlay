/**
 * Cuentas de las 4 gráficas propias del panel (16 nov 2026). Sin nada del navegador: se prueban con node.
 *
 * Las gráficas se dibujan con las velas de 15 s que el bot recibe de Pocket (no se carga ninguna página del
 * bróker: el 16 nov su sitio dejó de aceptar conexiones desde este equipo tras abrir cuatro terminales a la vez).
 */
(function (root) {
  const CANDLE_MS = 15000;

  /** Decimales con que se escribe un precio (1.12603 · 47.50852 · 186.483). */
  function digitsFor(price) {
    return Math.abs(price) >= 100 ? 3 : 5;
  }

  /** Cuántas velas caben en `width` píxeles con velas de `pitch` de paso (mínimo 8). */
  function visibleCount(width, pitch) {
    return Math.max(8, Math.floor(width / Math.max(4, pitch)));
  }

  /**
   * Escala vertical para un grupo de velas: precio → fila. Deja un margen arriba y abajo, y nunca una escala
   * de alto cero (velas planas).
   */
  function scaleOf(candles, top, height, extra = []) {
    let min = Infinity;
    let max = -Infinity;
    for (const c of candles) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
    }
    for (const v of extra) {
      if (Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    let span = max - min;
    if (!(span > 0)) span = Math.abs(max) * 0.0002 || 1e-6;
    const pad = span * 0.12;
    const lo = min - pad;
    const hi = max + pad;
    return { min: lo, max: hi, y: (price) => top + ((hi - price) / (hi - lo)) * height };
  }

  /**
   * En qué vela cae un instante: 0 = la más vieja de las `count` que se dibujan, count − 1 = la que va en curso.
   * @param {number} count velas dibujadas  @param {number} formingStart ms en que abrió la vela en curso
   * @returns {number|null} null si ese instante ya no está a la vista
   */
  function indexAt(count, formingStart, at, candleMs = CANDLE_MS) {
    if (!Number.isFinite(at) || !Number.isFinite(formingStart)) return null;
    const back = at >= formingStart ? 0 : Math.ceil((formingStart - at) / candleMs);
    const index = count - 1 - back;
    return index >= 0 ? index : null;
  }

  /** Precios «redondos» para las líneas de la rejilla (4 a 6 líneas). */
  function gridPrices(min, max, lines = 5) {
    const span = max - min;
    if (!(span > 0)) return [];
    const raw = span / lines;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) || raw;
    const out = [];
    for (let p = Math.ceil(min / step) * step; p <= max + step * 1e-9; p += step) out.push(Number(p.toPrecision(12)));
    return out;
  }

  const api = { CANDLE_MS, digitsFor, visibleCount, scaleOf, indexAt, gridPrices };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.wallMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
