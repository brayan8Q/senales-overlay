/**
 * Generador de velas de ejemplo (determinista) para probar la app.
 * Lo usan la página test/grafica.html y las pruebas en Node.
 */
(function (root) {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Devuelve `count` velas { open, close, high, low } de un paseo aleatorio. */
  function generate(seed, count) {
    const rand = mulberry32(seed);
    const candles = [];
    let price = 1000;
    for (let i = 0; i < count; i++) {
      let change = Math.round((rand() - 0.5) * 60);
      if (change === 0) change = 4;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.round(rand() * 14);
      const low = Math.min(open, close) - Math.round(rand() * 14);
      candles.push({ open, close, high, low, dir: close > open ? 'up' : 'down' });
      price = close;
    }
    return candles;
  }

  const api = { generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.gen = api;
})(typeof window !== 'undefined' ? window : globalThis);
