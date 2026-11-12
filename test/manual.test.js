/** Modo manual: la predicción se pide con el botón PREDECIR. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker } = require('../src/timed');
const { describeChart, systemPrompt } = require('../src/ai');
const { chain } = require('./helpers');

const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
const base = { candles: UP, cycleMs: 5000, payout: 85, manual: true, force: true };
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];

test('sin pulsar el botón no hay señales; al pulsar: analiza, da la señal, la califica y vuelve a reposo', () => {
  const t = createTimedTracker();
  let s = t.update({ ...base, priceY: -112, now: 0, pauseMs: 5000 });
  assert.equal(s.phase, 'idle');
  assert.equal(s.signal, null);
  assert.equal(s.ready, true);
  s = t.update({ ...base, priceY: -113, now: 30000, pauseMs: 5000 }); // pasa el tiempo: sigue en reposo
  assert.equal(s.phase, 'idle');

  assert.equal(t.predict(), true);
  s = t.update({ ...base, priceY: -113, now: 30300, pauseMs: 5000 });
  assert.equal(s.phase, 'analysis');
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false); // ya hay una en curso: pulsar otra vez no hace nada

  s = t.update({ ...base, priceY: -114, now: 35300, pauseMs: 5000 });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
  assert.equal(t.predict(), false);

  s = t.update({ ...base, priceY: -116, now: 40300, pauseMs: 5000 }); // subió -> acertó
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.phase, 'idle'); // no sale otra señal sola
  assert.equal(s.signal, null);
  assert.equal(s.ready, true);
  s = t.update({ ...base, priceY: -120, now: 60000, pauseMs: 5000 });
  assert.equal(s.phase, 'idle');
  assert.deepEqual(tally(s), [1, 0, 0]);

  assert.equal(t.predict(), true); // y se puede pedir otra
  s = t.update({ ...base, priceY: -120, now: 60300, pauseMs: 5000 });
  assert.equal(s.phase, 'analysis');
});

test('sin pausa de análisis, la señal sale en cuanto se pulsa', () => {
  const t = createTimedTracker();
  t.update({ ...base, priceY: -112, now: 0 });
  t.predict();
  const s = t.update({ ...base, priceY: -112, now: 300 });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
});

test('con IA: la señal sale en cuanto contesta, y si tarda se la espera un poco más', () => {
  const advice = { dir: 'down', confidence: 'media', reason: 'IA: rechazo.' };

  // Contesta a los 2 s: no hace falta esperar los 5 s de pausa
  let t = createTimedTracker();
  t.update({ ...base, priceY: -112, now: 0, pauseMs: 5000 });
  t.predict();
  let s = t.update({ ...base, priceY: -112, now: 300, pauseMs: 5000, waitForAdvice: true });
  assert.equal(s.phase, 'analysis');
  s = t.update({ ...base, priceY: -112, now: 2300, pauseMs: 5000, advice });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.source, 'ia');
  assert.equal(s.signal.dir, 'down');

  // Tarda 7 s: se la espera aunque la pausa (5 s) ya pasó
  t = createTimedTracker();
  t.update({ ...base, priceY: -112, now: 0, pauseMs: 5000 });
  t.predict();
  t.update({ ...base, priceY: -112, now: 300, pauseMs: 5000, waitForAdvice: true });
  s = t.update({ ...base, priceY: -112, now: 6000, pauseMs: 5000, waitForAdvice: true });
  assert.equal(s.phase, 'analysis');
  s = t.update({ ...base, priceY: -112, now: 7300, pauseMs: 5000, advice });
  assert.equal(s.signal.source, 'ia');

  // No contesta nunca: a los 5 s extra salen las reglas
  t = createTimedTracker();
  t.update({ ...base, priceY: -112, now: 0, pauseMs: 5000 });
  t.predict();
  t.update({ ...base, priceY: -112, now: 300, pauseMs: 5000, waitForAdvice: true });
  s = t.update({ ...base, priceY: -112, now: 9900, pauseMs: 5000, waitForAdvice: true });
  assert.equal(s.phase, 'analysis');
  s = t.update({ ...base, priceY: -112, now: 10400, pauseMs: 5000, waitForAdvice: true });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.source, 'reglas');
});

test('en automático el botón no hace falta', () => {
  const t = createTimedTracker();
  const s = t.update({ ...base, manual: false, priceY: -112, now: 0 });
  assert.equal(s.phase, 'signal');
});

test('a la IA se le pasa el activo y el recorrido reciente del precio, sin datos externos', () => {
  const ticks = [0, 300, 600, 900, 1200].map((time, i) => ({ time, y: -112 - i * 2 }));
  const snapshot = describeChart(UP, ['up'], 5, { asset: '  AED/CNY OTC  ', ticks });
  assert.equal(snapshot.activo, 'AED/CNY OTC');
  assert.equal(snapshot.precio_ultimos_segundos.segundos_que_abarca, 1.2);
  const path = snapshot.precio_ultimos_segundos.recorrido;
  assert.equal(path.length, 5);
  assert.equal(path[0], 0);
  assert.ok(path[4] > path[1] && path[1] > 0, JSON.stringify(path)); // subiendo

  // Sin activo ni lecturas, esos campos no se envían
  const plain = describeChart(UP, [], 5);
  assert.equal(plain.activo, undefined);
  assert.equal(plain.precio_ultimos_segundos, undefined);

  assert.match(systemPrompt(true), /mayor peso a lo más reciente/);
  assert.match(systemPrompt(true), /no supongas noticias ni datos externos/);
});
