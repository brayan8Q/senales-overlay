/** Lector de velas contra una captura REAL de la gráfica. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles } = require('../src/candles');

const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'grafica_real.png')));
const candles = readCandles(png.data, png.width, png.height);

test('encuentra las velas completas de la captura', () => {
  // De izquierda a derecha (la primera, cortada por el borde, no cuenta).
  const dirs = candles.map((c) => c.dir);
  assert.equal(candles.length, 11, JSON.stringify(dirs));
  assert.deepEqual(dirs.slice(0, 9), ['up', 'down', 'down', 'up', 'up', 'down', 'down', 'up', 'up']);
  assert.ok(['down', 'flat'].includes(dirs[9]));
  assert.equal(dirs[10], 'down');
});

test('la geometría de las velas es coherente', () => {
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close), 'la mecha superior no puede quedar bajo el cuerpo');
    assert.ok(c.low <= Math.min(c.open, c.close), 'la mecha inferior no puede quedar sobre el cuerpo');
    if (c.dir === 'up') assert.ok(c.close > c.open);
    if (c.dir === 'down') assert.ok(c.close < c.open);
  }
  const body = (c) => Math.abs(c.close - c.open);
  // La vela verde grande (la octava) tiene el cuerpo mayor que sus vecinas.
  assert.ok(body(candles[7]) > body(candles[6]) * 3);
  assert.ok(body(candles[7]) > body(candles[8]) * 3);
  // Van de izquierda a derecha sin encimarse.
  for (let i = 1; i < candles.length; i++) assert.ok(candles[i].x0 > candles[i - 1].x1);
});

test('una imagen sin velas no devuelve nada', () => {
  assert.deepEqual(readCandles(Buffer.alloc(100 * 60 * 4, 30), 100, 60), []);
});

// ---- Segunda captura real: gráfica en vivo con el globo "$0" de la plataforma ----
const { findPriceLine } = require('../src/candles');
const png2 = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'grafica_real2.png')));
const candles2 = readCandles(png2.data, png2.width, png2.height);

test('no confunde el globo rojo de una operación con una vela', () => {
  // El globo queda en x 555-575; ninguna vela leída debe estar ahí.
  assert.ok(candles2.length >= 20, `velas: ${candles2.length}`);
  assert.ok(candles2.every((c) => c.x1 < 540), JSON.stringify(candles2.map((c) => c.x0)));
  // Todas las velas tienen el mismo ancho (±2 px)
  const widths = candles2.map((c) => c.x1 - c.x0 + 1);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 3, JSON.stringify(widths));
});

test('localiza la línea del precio actual', () => {
  assert.equal(findPriceLine(png2.data, png2.width, png2.height), 506);
  assert.equal(findPriceLine(png.data, png.width, png.height), 239);
  assert.equal(findPriceLine(Buffer.alloc(100 * 60 * 4, 30), 100, 60), null);
});

// ---- Tercera captura real: hay DOS rayas horizontales (precio actual y orden pendiente) ----
const png3 = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'grafica_real3.png')));
const candles3 = readCandles(png3.data, png3.width, png3.height);

test('con dos rayas, elige la que pasa por el cierre de la vela en curso', () => {
  assert.equal(candles3.length, 9);
  const lastCloseRow = -candles3[candles3.length - 1].close;
  assert.equal(findPriceLine(png3.data, png3.width, png3.height, lastCloseRow), 335);
  // Con una pista junto a la otra raya (orden pendiente, ~399) elegiría esa: la pista manda.
  const other = findPriceLine(png3.data, png3.width, png3.height, 399);
  assert.ok(Math.abs(other - 399) <= 1, `fila ${other}`);
});
