const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, NO_SIGNAL_MS } = require('../src/timed');
const { chain } = require('./helpers');

// Cuando no sale predicción (ESPERAR) el panel no se queda bloqueado todo el plazo: se libera a
// los 10 segundos para poder pedir otra.
const row = (price) => -price;
// Velas de lado y vela en curso sin fuerza: sin "dar siempre un lado", no hay señal.
const FLAT = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1]);
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
const read = (t, candles, price, now, cycleMs) => t.update({ candles, priceY: row(price), now, cycleMs, payout: 92, manual: true });

test('la constante es la pedida: 10 segundos', () => {
  assert.equal(NO_SIGNAL_MS, 10000);
});

test('a 5 minutos, si no hay predicción el panel se libera a los 10 s (no a los 5 min)', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, FLAT, 101, 0, 300000);
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, null); // ESPERAR
  assert.equal(s.remainingMs, 10000);
  assert.equal(t.predict(), false); // mientras tanto no se enciman predicciones
  s = read(t, FLAT, 101, 9000, 300000);
  assert.equal(s.phase, 'signal');
  assert.equal(s.remainingMs, 1000);
  s = read(t, FLAT, 103, 10000, 300000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.ready, true);
  assert.match(s.lastResult, /^no dio predicción/);
  assert.deepEqual([s.live.wins, s.live.losses, s.live.ties], [0, 0, 0]); // no cuenta como nada
  assert.equal(t.predict(), true);
});

test('con plazo corto (5 s) el ESPERAR sigue durando el plazo', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, FLAT, 101, 0, 5000);
  assert.equal(s.signal.dir, null);
  assert.equal(s.remainingMs, 5000);
  s = read(t, FLAT, 101, 5000, 5000);
  assert.equal(s.phase, 'idle');
});

test('una señal CON lado sí dura los 5 minutos completos', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, UP, 112, 0, 300000);
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.remainingMs, 300000);
  s = read(t, UP, 113, 60000, 300000);
  assert.equal(s.phase, 'signal');
  s = read(t, UP, 115, 300000, 300000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'acertó');
});
