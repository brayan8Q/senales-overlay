/** El análisis se hace comparando con las velas ANTERIORES: tamaño normal y último pico/piso. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles } = require('../src/candles');
const { candlePattern } = require('../src/signal');
const { computeReadings } = require('../src/readings');
const { chain } = require('./helpers');

const candle = (open, close, high, low) => ({ dir: close > open ? 'up' : close < open ? 'down' : 'flat', open, close, high, low });
const TIME = Date.UTC(2026, 10, 12, 13);

test('una vela que apenas abre (pequeña frente a las anteriores) no cuenta como "cuerpo fuerte"', () => {
  const before = chain([10, -10, 10, -10, 10, -10]); // cuerpos normales de 10
  // Casi toda cuerpo, pero cinco veces más chica que lo normal: todavía no dice nada
  const tinyUp = candlePattern(candle(100, 102, 102.2, 99.9), before[before.length - 1], before);
  assert.equal(tinyUp.vote, 0);
  assert.match(tinyUp.text, /verde pequeña/);
  const tinyDown = candlePattern(candle(102, 100, 102.1, 99.8), before[before.length - 1], before);
  assert.equal(tinyDown.vote, 0);
  assert.match(tinyDown.text, /roja pequeña/);
  // Con tamaño normal sí es cuerpo fuerte y vota
  assert.deepEqual(candlePattern(candle(100, 108, 109, 99.5), before[before.length - 1], before), { vote: 1, text: 'cuerpo fuerte verde' });
  // Sin velas anteriores con qué comparar, se queda como antes
  assert.equal(candlePattern(candle(100, 102, 102.2, 99.9)).vote, 1);
});

test('el pico más reciente sale como resistencia (y el piso más reciente como soporte)', () => {
  // Sube, hace pico con mecha larga, y las dos velas siguientes ya no lo superan
  const rising = chain([4, 5, 4, 5, 4, 5, 4, 5]);
  const top = rising[rising.length - 1].close;
  const peak = candle(top, top + 1, top + 12, top - 1); // mecha hasta +12
  const after = candle(top + 1, top - 2, top + 3, top - 3);
  const forming = candle(top - 2, top - 1, top, top - 3);
  const r = computeReadings({ candles: [...rising, peak, after], forming, time: TIME });
  assert.equal(r.rows.resistance, -(top + 12), 'la resistencia es el pico reciente');
  assert.ok(r.data.resistencia_arriba, 'y se le manda a la IA');

  // Lo mismo, volteado: el piso más reciente es el soporte
  const flip = (c) => candle(-c.open, -c.close, -c.low, -c.high);
  const m = computeReadings({ candles: [...rising, peak, after].map(flip), forming: flip(forming), time: TIME });
  assert.equal(m.rows.support, top + 12);

  // Si la vela en curso ya superó el pico, deja de ser resistencia
  const broke = candle(top - 2, top + 14, top + 15, top - 3);
  const b = computeReadings({ candles: [...rising, peak, after], forming: broke, time: TIME });
  assert.equal(b.rows.resistance, null);
});

test('captura real a M10 / S15: lee las 26 velas y marca el pico reciente como resistencia', () => {
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'm10_s15.png')));
  const candles = readCandles(png.data, png.width, png.height);
  assert.equal(candles.length, 26);
  // Paso uniforme entre velas: no falta ninguna en medio
  for (let i = 1; i < candles.length; i++) assert.ok(Math.abs(candles[i].x0 - candles[i - 1].x0 - 26) <= 2, `vela ${i + 1}`);
  const r = computeReadings({ candles: candles.slice(0, -1), forming: candles[candles.length - 1], time: TIME, trendCandles: 20 });
  assert.equal(r.items[0].name, 'Tendencia · 20 velas');
  assert.equal(r.items[0].vote, 1); // viene subiendo desde el piso
  assert.ok(r.rows.resistance !== null && r.rows.resistance < 60, 'resistencia en el pico de arriba: fila ' + r.rows.resistance);
  assert.ok(r.rows.support !== null && r.rows.support > 300, 'soporte abajo: fila ' + r.rows.support);
});
