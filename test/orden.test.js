/** Con una operación abierta: la línea de la orden y el aviso de la plataforma no rompen la lectura. Y el freno de "movimiento agotado". */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles, findPriceLine, findPriceLabel } = require('../src/candles');
const { createQualityGate } = require('../src/quality');
const { climax } = require('../src/signal');
const { chain } = require('./helpers');

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const shape = (c) => [c.x0, c.x1, c.dir, c.open, c.close, c.high, c.low].join(',');

test('captura real con operación abierta: la línea verde de la orden no hace perder la vela actual', () => {
  const png = load('orden_abierta.png');
  const candles = readCandles(png.data, png.width, png.height);
  const last = candles[candles.length - 1];
  assert.ok(Math.abs(last.x0 - 664) <= 2, 'la última vela leída es la actual: x ' + last.x0);
  assert.equal(last.dir, 'up');
  const label = findPriceLabel(png.data, png.width, png.height);
  const line = findPriceLine(png.data, png.width, png.height, label);
  const check = createQualityGate().inspect(candles, line, 0);
  assert.equal(check.forming, true, 'la línea del precio pasa por el cierre de la vela actual');
  // El aviso "Trade order placed" tapa dos velas en medio: se detecta el hueco y no se da por completa
  assert.equal(check.complete, false);
  assert.match(check.reason, /tapa 2 velas en medio/);
});

test('una línea de orden dibujada desde la vela anterior (verde o roja, de 1 o 2 px) no cambia ninguna vela', () => {
  const clean = load('m10_s15.png');
  const before = readCandles(clean.data, clean.width, clean.height).map(shape);
  assert.equal(before.length, 26);
  for (const [color, thick] of [[[70, 190, 60], 1], [[70, 190, 60], 2], [[255, 60, 40], 1], [[255, 60, 40], 2]]) {
    const png = load('m10_s15.png');
    // Desde la mitad de la penúltima vela hacia la derecha, a la altura del cuerpo de la actual
    for (let y = 158; y < 158 + thick; y++) {
      for (let x = 652; x <= 800; x++) {
        const p = (y * png.width + x) * 4;
        [png.data[p], png.data[p + 1], png.data[p + 2]] = color;
      }
    }
    const after = readCandles(png.data, png.width, png.height).map(shape);
    assert.equal(after.length, 26, `línea ${color} de ${thick} px`);
    assert.equal(after[25].split(',')[0], before[25].split(',')[0], 'la vela actual sigue en su sitio');
    assert.deepEqual(after.slice(0, 24), before.slice(0, 24));
  }
});

test('sin hueco entre velas la lectura se da por completa', () => {
  const png = load('m10_s15.png');
  const candles = readCandles(png.data, png.width, png.height);
  const check = createQualityGate().inspect(candles, null, 0);
  assert.equal(check.complete, true);
});

test('freno: movimiento agotado = recorrió mucho en pocas velas y está en el extremo', () => {
  // De lado y luego 4 velas fuertes hacia abajo: está en el piso de lo que se ve
  const crash = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, -9, -8, -9, -7]);
  const spent = climax(crash);
  assert.equal(spent.dir, 'down');
  assert.match(spent.text, /ya cayó/);
  // Lo mismo hacia arriba
  const rally = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 9, 8, 9, 7]);
  assert.equal(climax(rally).dir, 'up');
  // De lado: nada
  assert.equal(climax(chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2])), null);
  // Cayó fuerte pero ya rebotó la mitad: ya no está en el piso
  assert.equal(climax(chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, -9, -8, -9, -7, 9, 8])), null);
  // Pocas velas: no opina
  assert.equal(climax(chain([-9, -8, -9])), null);
});

test('freno en la captura real del piso: salta en las velas del fondo y no en las demás', () => {
  const png = load('piso.png');
  const candles = readCandles(png.data, png.width, png.height);
  const at = (n) => climax(candles.slice(0, n));
  for (const n of [18, 19, 20, 21]) assert.equal(at(n) && at(n).dir, 'down', 'vela ' + n);
  for (const n of [12, 14, 16, 23, 24, 25]) assert.equal(at(n), null, 'vela ' + n);
});
