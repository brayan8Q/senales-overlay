/** Costo por predicción y medición desde el momento en que el usuario entra. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { costOf, priceOf } = require('../src/prices');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

test('costo de una consulta: tokens por el precio del modelo', () => {
  // 2500 de entrada y 500 de salida en Claude Fable 5.2 (8 y 40 dólares por millón)
  assert.equal(Math.round(costOf('claude-fable-5-2', { input: 2500, output: 500 }) * 1e5) / 1e5, 0.04);
  assert.equal(Math.round(costOf('gpt-6-astra', { input: 2500, output: 400 }) * 1e5) / 1e5, 0.045);
  // Gemini 4 Argon: precio de lanzamiento hasta noviembre, el doble desde diciembre de 2026
  assert.equal(Math.round(costOf('gemini-4-argon', { input: 2500, output: 400 }, Date.UTC(2026, 10, 12)) * 1e5) / 1e5, 0.009);
  assert.equal(Math.round(costOf('gemini-4-argon', { input: 2500, output: 400 }, Date.UTC(2026, 11, 2)) * 1e5) / 1e5, 0.018);
  // Modelo sin precio conocido: no se inventa
  assert.equal(costOf('modelo-desconocido', { input: 1000, output: 1000 }), null);
  assert.equal(priceOf('modelo-desconocido'), null);
});

test('la señal se mide desde que el usuario entra (retraso de entrada), no desde que aparece', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const base = { candles, cycleMs: 5000, payout: 85, force: true, entryMs: 2000 };
  const quote = (value) => ({ value, perPixel: 0.00004 });
  const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];

  // Señal ARRIBA a 1.20000. En los 2 s que tarda en entrar el precio BAJA a 1.19980,
  // y desde ahí sube a 1.19990: respecto a la señal bajó, respecto a la entrada subió.
  const t = createTimedTracker();
  let s = t.update({ ...base, priceY: -112, now: 0, quote: quote(1.2) });
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.remainingMs, 7000); // 2 s de entrada + 5 s de operación
  s = t.update({ ...base, priceY: -112, now: 2000, quote: quote(1.1998) }); // aquí entra la orden
  s = t.update({ ...base, priceY: -112, now: 5000, quote: quote(1.19985) });
  assert.deepEqual(tally(s), [0, 0, 0]); // a los 5 s todavía no se califica
  assert.equal(s.phase, 'signal');
  s = t.update({ ...base, priceY: -112, now: 7000, quote: quote(1.1999) });
  assert.deepEqual(tally(s), [1, 0, 0]); // subió desde la entrada: acertó
  assert.equal(s.lastResult, 'acertó');

  // Sin retraso de entrada, esa misma señal habría contado como fallada
  const t0 = createTimedTracker();
  t0.update({ ...base, entryMs: 0, priceY: -112, now: 0, quote: quote(1.2) });
  s = t0.update({ ...base, entryMs: 0, priceY: -112, now: 5000, quote: quote(1.19985) });
  assert.deepEqual(tally(s), [0, 1, 0]);
});
