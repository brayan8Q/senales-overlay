/** Historial largo de velas: se acumula lectura a lectura aunque en pantalla quepan pocas. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, fit } = require('../src/history');
const { chain } = require('./helpers');

/** Variaciones pseudoaleatorias (siempre las mismas) entre -6 y 6, sin ceros. */
function changes(count, seed = 7) {
  let state = seed;
  const out = [];
  while (out.length < count) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const value = (state % 13) - 6;
    if (value !== 0) out.push(value);
  }
  return out;
}

const VISIBLE = 20; // velas cerradas que caben en pantalla
const FULL = chain(changes(160));
const view = (candles, scale = 1, offset = 0) =>
  candles.map((c) => ({ ...c, open: c.open * scale + offset, close: c.close * scale + offset, high: c.high * scale + offset, low: c.low * scale + offset }));
/** Lo que se ve en pantalla cuando ya cerraron `closed` velas: las ultimas 20 cerradas + la que esta en curso. */
const frame = (closed, scale = 1, offset = 0) => view(FULL.slice(closed - VISIBLE, closed + 1), scale, offset);
const closes = (candles) => candles.map((c) => Math.round(c.close * 10) / 10);

test('recta de ajuste', () => {
  const { a, b } = fit([[0, 5], [10, 25], [20, 45]]);
  assert.equal(Math.round(a * 1000) / 1000, 2);
  assert.equal(Math.round(b * 1000) / 1000, 5);
});

test('acumula las velas que van cerrando, más allá de las 20 que caben en pantalla, hasta 60', () => {
  const h = createHistory();
  let s;
  for (let closed = VISIBLE; closed <= 150; closed++) {
    s = h.update(frame(closed), -FULL[closed].close, closed * 1000);
    // Varias lecturas de la misma pantalla no duplican nada
    s = h.update(frame(closed), -FULL[closed].close, closed * 1000 + 300);
  }
  // El historial es corto a propósito: se queda con las últimas 60
  assert.equal(s.candles.length, 60);
  assert.deepEqual(closes(s.candles), closes(FULL.slice(90, 150)));
});

test('si la gráfica cambia de escala o se desplaza, el historial se pasa a la escala nueva', () => {
  const h = createHistory();
  let s;
  let scale = 1;
  let offset = 0;
  for (let closed = VISIBLE; closed <= 120; closed++) {
    // Cada 5 velas la plataforma reescala y desplaza la gráfica
    if (closed % 5 === 0) {
      scale = 1 + ((closed * 7) % 11) / 10; // entre 1.0 y 2.0
      offset = (closed * 13) % 40;
    }
    s = h.update(frame(closed, scale, offset), -(FULL[closed].close * scale + offset), closed * 1000);
  }
  assert.equal(s.candles.length, 60);
  const expected = view(FULL.slice(60, 120), scale, offset);
  for (let i = 0; i < 60; i++) {
    assert.ok(Math.abs(s.candles[i].close - expected[i].close) < 0.5, `vela ${i}: ${s.candles[i].close} vs ${expected[i].close}`);
    assert.ok(Math.abs(s.candles[i].low - expected[i].low) < 0.5);
  }
  // El recorrido del precio queda en la misma escala que las velas
  const lastPrice = s.prices[s.prices.length - 1];
  assert.ok(Math.abs(lastPrice.value - (FULL[120].close * scale + offset)) < 0.01);
  const older = s.prices[s.prices.length - 10]; // de cuando había otra escala
  assert.ok(Math.abs(older.value - (FULL[111].close * scale + offset)) < 0.5, String(older.value));
});

test('una lectura rara suelta no borra el historial; una gráfica distinta de verdad sí lo reinicia', () => {
  const h = createHistory();
  let s;
  for (let closed = VISIBLE; closed <= 50; closed++) s = h.update(frame(closed), -FULL[closed].close, closed * 1000);
  assert.equal(s.candles.length, 50);

  // Tres lecturas de algo que no se reconoce (p. ej. un globo tapando velas)
  const other = chain(changes(30, 99), 1, 300);
  for (let i = 0; i < 3; i++) s = h.update(other.slice(0, 21), -300, 51000 + i * 300);
  assert.equal(s.candles.length, 20); // mientras tanto solo se usa lo que se ve
  assert.equal(s.restarted, false);
  // Vuelve la gráfica de antes: el historial sigue completo
  s = h.update(frame(51), -FULL[51].close, 52000);
  assert.equal(s.candles.length, 51);

  // Ahora sí cambia de gráfica (otro activo) y se queda así
  for (let i = 0; i < 12; i++) s = h.update(other.slice(0, 21), -300, 53000 + i * 300);
  assert.equal(s.restarted, true);
  assert.equal(s.candles.length, 20);
  assert.equal(s.prices.length, 1); // solo el precio de la gráfica nueva
});

test('guarda el precio de los últimos 10 minutos, como mucho una lectura cada 250 ms', () => {
  const h = createHistory();
  let s;
  for (let i = 0; i <= 2000; i++) s = h.update(frame(40), -(FULL[40].close + (i % 5)), i * 100); // 200 s, cada 100 ms
  let span = s.prices[s.prices.length - 1].time - s.prices[0].time;
  assert.equal(span, 199800); // todavía cabe todo
  assert.ok(s.prices.length <= 200000 / 250 + 1 && s.prices.length > 600, String(s.prices.length));
  // Pasados 10 minutos, lo más viejo se va
  for (let i = 0; i <= 7400; i++) s = h.update(frame(40), -FULL[40].close, 200000 + i * 250);
  span = s.prices[s.prices.length - 1].time - s.prices[0].time;
  assert.ok(span <= 10 * 60 * 1000 && span > 9.9 * 60 * 1000, String(span));
});
