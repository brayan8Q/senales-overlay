// Cuentas de las 4 graficas propias del panel (16 nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const { digitsFor, visibleCount, scaleOf, indexAt, gridPrices } = require('../renderer/wallmath');

test('los precios se escriben con los decimales de cada par', () => {
  assert.strictEqual((1.12603).toFixed(digitsFor(1.12603)), '1.12603');
  assert.strictEqual((186.483).toFixed(digitsFor(186.483)), '186.483');
  assert.strictEqual((47.50852).toFixed(digitsFor(47.50852)), '47.50852');
});

test('la escala pone el maximo arriba y el minimo abajo, con margen, y aguanta velas planas', () => {
  const candles = [{ open: 1, high: 1.2, low: 0.9, close: 1.1 }, { open: 1.1, high: 1.3, low: 1.0, close: 1.25 }];
  const scale = scaleOf(candles, 10, 200);
  assert.ok(scale.y(1.3) > 10 && scale.y(1.3) < scale.y(0.9) && scale.y(0.9) < 210);
  const withEntry = scaleOf(candles, 10, 200, [1.6]);
  assert.ok(withEntry.y(1.6) > 10 && withEntry.max > 1.6); // el precio de entrada tambien queda a la vista
  const flat = scaleOf([{ open: 5, high: 5, low: 5, close: 5 }], 0, 100);
  assert.ok(Number.isFinite(flat.y(5)) && flat.y(5) > 0 && flat.y(5) < 100);
  assert.strictEqual(scaleOf([], 0, 100), null);
});

test('un instante se ubica en su vela: la que va en curso es la ultima', () => {
  const start = 1000000; // abrio la vela en curso
  assert.strictEqual(indexAt(40, start, start + 3000), 39);
  assert.strictEqual(indexAt(40, start, start - 1), 38);
  assert.strictEqual(indexAt(40, start, start - 15000), 38);
  assert.strictEqual(indexAt(40, start, start - 15001), 37);
  assert.strictEqual(indexAt(40, start, start - 40 * 15000), null); // ya no esta a la vista
  assert.strictEqual(indexAt(40, start, undefined), null);
});

test('caben mas velas en una grafica mas ancha y la rejilla da precios redondos dentro del rango', () => {
  assert.ok(visibleCount(800, 13) > visibleCount(400, 13));
  assert.strictEqual(visibleCount(10, 13), 8);
  const lines = gridPrices(1.12543, 1.12688, 5);
  assert.ok(lines.length >= 3 && lines.length <= 9);
  for (const p of lines) assert.ok(p >= 1.12543 && p <= 1.12688 + 1e-9);
  assert.deepStrictEqual(gridPrices(1, 1), []);
});
