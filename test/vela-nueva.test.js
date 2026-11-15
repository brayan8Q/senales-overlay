const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, SYNC_LEAD_MS, SYNC_LATE_MS, SYNC_OPEN_MS } = require('../src/timed');
const { chain } = require('./helpers');

// PREDICCIÓN AL ABRIR CADA VELA NUEVA: se analiza al final de la vela en curso y la señal sale en
// cuanto abre la siguiente. Velas de 15 s; el reloj de la vela lo da quien llama.
const row = (price) => -price;
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // las reglas dan ARRIBA
const PERIOD = 15000;
const clock = (now) => ({ known: true, seconds: 15, elapsedMs: now % PERIOD, remainingMs: PERIOD - (now % PERIOD), closedNow: now % PERIOD === 0, closeRow: null });
const make = ({ manual = false, pauseMs = 5000, newCandle = true, known = true } = {}) => {
  const t = createTimedTracker();
  const read = (now, price = 112) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, pauseMs, payout: 92, manual, newCandle, candle: known ? clock(now) : { known: false } });
  return { t, read };
};

test('automático: analiza al final de la vela y la señal sale justo al abrir la siguiente', () => {
  const { read } = make();
  let s = read(1000); // la vela lleva 1 s: todavía no toca
  assert.equal(s.phase, 'waiting');
  assert.equal(s.remainingMs, 14000);
  s = read(9000); // le faltan 6 s: aún no (el análisis dura 5 s)
  assert.equal(s.phase, 'waiting');
  s = read(PERIOD - 5000 - SYNC_LEAD_MS); // le faltan 5.5 s: empieza el análisis
  assert.equal(s.phase, 'analysis');
  s = read(13000);
  assert.equal(s.phase, 'analysis');
  s = read(14500); // el análisis terminó, pero la vela aún no cierra: se espera
  assert.equal(s.phase, 'waiting');
  assert.equal(s.signal, null);
  s = read(15000); // abre la vela nueva: sale la señal
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.remainingMs, 3000);
});

test('una señal por vela: tras calificar, la siguiente espera al final de la vela y sale al abrir la otra', () => {
  const { read } = make();
  read(PERIOD - 5500);
  read(14500);
  let s = read(15000);
  assert.equal(s.phase, 'signal');
  s = read(18000, 114); // 3 s después se califica
  assert.equal(s.lastResult, 'acertó');
  assert.equal(s.phase, 'waiting'); // no encima otra predicción en la misma vela
  s = read(22000);
  assert.equal(s.phase, 'waiting');
  s = read(2 * PERIOD - 5400);
  assert.equal(s.phase, 'analysis');
  s = read(2 * PERIOD - 300);
  assert.equal(s.phase, 'waiting');
  s = read(2 * PERIOD + 200);
  assert.equal(s.phase, 'signal');
});

test('con el botón: PREDECIR a media vela espera, analiza al final y predice al abrir la vela nueva', () => {
  const { t, read } = make({ manual: true });
  let s = read(3000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.ready, true);
  t.predict();
  s = read(3300);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false);
  s = read(9600);
  assert.equal(s.phase, 'analysis');
  s = read(14700);
  assert.equal(s.phase, 'waiting');
  s = read(15300);
  assert.equal(s.phase, 'signal');
});

test('si se llega un poco tarde, el análisis termina con la vela recién abierta y la señal sale ahí', () => {
  const { t, read } = make({ manual: true });
  t.predict();
  let s = read(11000); // faltan 4 s: el análisis empieza ya y terminará 1 s dentro de la vela nueva
  assert.equal(s.phase, 'analysis');
  s = read(16000);
  assert.equal(s.phase, 'signal'); // la vela nueva lleva 1 s
  assert.ok(SYNC_OPEN_MS >= 1500);
});

test('si ya no da tiempo en esta vela, no sale a media vela: se espera a la siguiente', () => {
  const { t, read } = make({ manual: true });
  t.predict();
  let s = read(13000); // faltan 2 s: el análisis (5 s) acabaría 3 s dentro de la vela nueva
  assert.equal(s.phase, 'waiting');
  s = read(18000);
  assert.equal(s.phase, 'waiting'); // nada a media vela
  s = read(PERIOD + 9600);
  assert.equal(s.phase, 'analysis');
  s = read(2 * PERIOD - 300);
  assert.equal(s.phase, 'waiting');
  s = read(2 * PERIOD + 300);
  assert.equal(s.phase, 'signal');
  assert.equal(SYNC_LATE_MS, 1500);
});

test('sin análisis (0 s): la señal solo sale al abrir una vela', () => {
  const { read } = make({ pauseMs: 0 });
  let s = read(7000);
  assert.equal(s.phase, 'waiting');
  s = read(14900);
  assert.equal(s.phase, 'waiting');
  s = read(15200);
  assert.equal(s.phase, 'signal');
});

test('apagado, o sin reloj de la vela, todo sigue como antes: analiza y predice al momento', () => {
  let { read } = make({ newCandle: false });
  let s = read(1000);
  assert.equal(s.phase, 'analysis');
  s = read(6000);
  assert.equal(s.phase, 'signal');

  ({ read } = make({ known: false }));
  s = read(1000);
  assert.equal(s.phase, 'analysis');
  s = read(6000);
  assert.equal(s.phase, 'signal');
});

test('la martingala no espera a la vela: sale en cuanto la señal pierde', () => {
  const t = createTimedTracker();
  const read = (now, price) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, martin: 1, candle: clock(now) });
  read(PERIOD - 5500, 112);
  read(14500, 112);
  let s = read(15000, 112);
  assert.equal(s.phase, 'signal');
  s = read(18000, 110); // perdió a los 3 s de la vela
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.phase, 'signal');
});
