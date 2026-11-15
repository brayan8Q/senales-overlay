/** Marca de una operación abierta ("▼ $1" junto a la vela): conteo sobre imágenes REALES del panel. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles, findPriceLine, findPriceLabel } = require('../src/candles');
const { findResultBadges } = require('../src/badges');
const { countOrderMark, MARK_MIN } = require('../src/ordermark');

/** Lo mismo que hace el panel en cada lectura: velas, fila del precio, globos y blancos junto a la vela. */
function markIn(name, { withBadges = true } = {}) {
  const { data, width, height } = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
  const candles = readCandles(data, width, height);
  const forming = candles[candles.length - 1];
  const label = findPriceLabel(data, width, height);
  let row = findPriceLine(data, width, height, label !== null ? label : -forming.close);
  if (row === null) row = label !== null ? Math.round(label) : Math.round(-forming.close);
  const badges = withBadges ? findResultBadges(data, width, height) : [];
  return { count: countOrderMark(data, width, height, { x0: forming.x0, x1: forming.x1, row, badges }), badges };
}

test('sin operación abierta no hay blancos junto a la vela', () => {
  assert.equal(markIn('sin_operacion.png').count, 0);
});

test('con una operación abierta se ve su marca; con dos, el doble', () => {
  const one = markIn('marca_una.png').count;
  assert.ok(one >= MARK_MIN && one < 50, `una marca: ${one} blancos`);
  const two = markIn('marca_operacion.png').count;
  assert.ok(two >= 2 * MARK_MIN, `dos marcas: ${two} blancos`);
  assert.ok(two - one >= MARK_MIN, 'la segunda operación se nota sobre la primera');
});

test('el globo del resultado (letras blancas) no se confunde con una entrada', () => {
  const masked = markIn('globo_sin_marca.png');
  assert.equal(masked.badges.length, 1);
  assert.ok(masked.count < MARK_MIN, `con el globo descontado: ${masked.count}`);
  // Sin descontarlo sí habría bastantes blancos: por eso se descuenta.
  assert.ok(markIn('globo_sin_marca.png', { withBadges: false }).count >= MARK_MIN);
});

test('si no se sabe dónde está la vela o el precio, no se inventa una cuenta', () => {
  const data = Buffer.alloc(40 * 40 * 4, 255);
  assert.equal(countOrderMark(data, 40, 40, { x0: NaN, x1: 10, row: 20 }), null);
  assert.equal(countOrderMark(data, 40, 40, { x0: 5, x1: 10, row: null }), null);
  assert.ok(countOrderMark(data, 40, 40, { x0: 5, x1: 10, row: 20 }) > 0);
});
