/** Utilidades para las pruebas (no es un archivo de pruebas). */

/**
 * Construye velas encadenadas a partir de variaciones de precio
 * (+ sube, - baja, 0 plana). `scale` simula otra escala vertical.
 */
function chain(changes, scale = 1, start = 100) {
  let price = start;
  return changes.map((change, i) => {
    const open = price;
    const close = price + change;
    price = close;
    const wick = 1 + (i % 3);
    return {
      x0: i * 10,
      x1: i * 10 + 7,
      dir: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      open: open * scale,
      close: close * scale,
      high: (Math.max(open, close) + wick) * scale,
      low: (Math.min(open, close) - wick) * scale,
    };
  });
}

module.exports = { chain };
