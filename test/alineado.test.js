const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, EARLY_CANDLE_MS, PRICE_LOST_MS } = require('../src/timed');
const { chain } = require('./helpers');

// PREDECIR alineado con el cambio de vela (modo manual): ver "2b" en src/timed.js.
const row = (price) => -price; // en pantalla, mas arriba = fila menor
// Tendencia alcista con vela en curso fuerte: la señal sale ARRIBA. La vela en curso abrió en 107.
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
const CYCLE = 5000;
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];

/** Reloj de una vela de `seconds` segundos que lleva `elapsedMs` abierta. */
const clock = (elapsedMs, extra = {}, seconds = 15) => ({
  known: true,
  seconds,
  elapsedMs,
  remainingMs: Math.max(0, seconds * 1000 - elapsedMs),
  closedNow: false,
  closeRow: null,
  ...extra,
});
/** Todavía no se sabe cuánto dura la vela. */
const noClock = (extra = {}) => ({ known: false, seconds: 0, elapsedMs: null, remainingMs: null, closedNow: false, closeRow: null, ...extra });
const read = (t, price, now, candle, extra = {}) =>
  t.update({
    candles: UP,
    priceY: price === null ? null : row(price),
    now,
    cycleMs: CYCLE,
    payout: 85,
    pauseMs: extra.pauseMs || 0,
    manual: extra.manual !== false,
    align: true,
    candle,
    clean: extra.clean !== false,
  });

test('las constantes de la espera son las pedidas: 8 s y 90 s', () => {
  assert.equal(EARLY_CANDLE_MS, 8000);
  assert.equal(PRICE_LOST_MS, 90000);
});

test('PREDECIR con la vela recién abierta: predice ESA vela ya y la califica a su cierre', () => {
  const t = createTimedTracker();
  assert.equal(t.predict(), true);
  let s = read(t, 112, 1000, clock(3000)); // lleva 3 s de 15: límite = min(8 s, 15/3) = 5 s
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.untilClose, true);
  assert.equal(s.signal.untilClose, true);
  assert.equal(s.remainingMs, 12000); // lo que le falta a la vela

  // Pasan los 5 s del plazo de antes: NO se califica, la señal vale hasta el cierre.
  s = read(t, 115, 7000, clock(9000));
  assert.equal(s.phase, 'signal');
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(s.remainingMs, 6000);

  // Cierra la vela en 113, arriba del precio de la señal (112): acertó.
  s = read(t, 113.5, 13200, clock(0, { closedNow: true, closeRow: row(113) }));
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.lastResult, 'acertó');
  assert.equal(s.phase, 'idle');
  assert.equal(s.ready, true);
});

test('se compara con el precio del momento de la señal, no con la apertura de la vela', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 1000, clock(2000));
  assert.equal(s.signal.dir, 'up');
  // La vela abrió en 107 y cierra en 110: verde, pero por DEBAJO del precio de la señal (112): falló.
  s = read(t, 110, 14100, clock(0, { closedNow: true, closeRow: row(110) }));
  assert.deepEqual(tally(s), [0, 1, 0]);
  assert.equal(s.lastResult, 'falló');
});

test('PREDECIR con la vela avanzada: espera, y el análisis arranca al abrir la siguiente', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 1000, clock(9000), { pauseMs: 3000 }); // lleva 9 s de 15
  assert.equal(s.phase, 'waiting');
  assert.equal(s.remainingMs, 6000); // cuenta regresiva hasta la vela nueva
  assert.equal(s.signal, null);
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false); // el botón queda bloqueado: no se enciman predicciones

  s = read(t, 113, 4000, clock(12000), { pauseMs: 3000 });
  assert.equal(s.phase, 'waiting');
  assert.equal(s.remainingMs, 3000);

  // Abre la vela nueva: el análisis empieza en esa misma lectura.
  s = read(t, 112, 7100, clock(0, { closedNow: true }), { pauseMs: 3000 });
  assert.equal(s.phase, 'analysis');
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false);

  // Termina el análisis: la señal es para el cierre de ESA vela nueva.
  s = read(t, 112, 10200, clock(3100), { pauseMs: 3000 });
  assert.equal(s.phase, 'signal');
  assert.equal(s.untilClose, true);
  assert.equal(s.remainingMs, 11900);

  s = read(t, 114, 22300, clock(0, { closedNow: true, closeRow: row(114) }), { pauseMs: 3000 });
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.phase, 'idle');
});

test('el límite es 1/3 de la duración de la vela cuando eso es menos de 8 s', () => {
  // Vela de 15 s con 6 s abierta: 6 > 15/3 -> espera.
  let t = createTimedTracker();
  t.predict();
  assert.equal(read(t, 112, 0, clock(6000)).phase, 'waiting');
  // Vela de 1 min con 7 s abierta: 7 <= 8 -> predice ya.
  t = createTimedTracker();
  t.predict();
  assert.equal(read(t, 112, 0, clock(7000, {}, 60)).phase, 'signal');
  // Vela de 1 min con 9 s abierta: ya pasó de 8 s -> espera.
  t = createTimedTracker();
  t.predict();
  assert.equal(read(t, 112, 0, clock(9000, {}, 60)).phase, 'waiting');
});

test('esperando la vela: si el precio deja de llegar 90 s, se cancela y vuelve a LISTO', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 0, clock(9000));
  assert.equal(s.phase, 'waiting');
  // La gráfica deja de leerse (sin línea de precio). Ni un cambio de vela arranca nada así.
  for (let now = 1000; now < PRICE_LOST_MS; now += 1000) {
    s = read(t, null, now, noClock({ closedNow: now === 6000 }));
    assert.equal(s.phase, 'waiting', `a los ${now / 1000} s sigue esperando`);
    assert.equal(t.predict(), false);
  }
  s = read(t, null, PRICE_LOST_MS, noClock());
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /se canceló/);
  assert.deepEqual(tally(s), [0, 0, 0]);
  // Vuelve el precio: se puede pedir otra.
  s = read(t, 112, PRICE_LOST_MS + 1000, clock(1000));
  assert.equal(s.ready, true);
  assert.equal(t.predict(), true);
});

test('si el precio vuelve antes de los 90 s, la espera sigue y arranca en la vela nueva', () => {
  const t = createTimedTracker();
  t.predict();
  read(t, 112, 0, clock(9000));
  let s = read(t, null, 60000, noClock());
  assert.equal(s.phase, 'waiting');
  s = read(t, 112, 80000, clock(10000)); // volvió el precio: el contador de 90 s empieza de nuevo
  assert.equal(s.phase, 'waiting');
  s = read(t, 112, 150000, clock(14000));
  assert.equal(s.phase, 'waiting');
  s = read(t, 112, 151000, clock(0, { closedNow: true }));
  assert.equal(s.phase, 'signal');
});

test('gráfica tapada justo al cierre: se califica con el cierre de la vela cuando se destapa', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 0, clock(1000));
  assert.equal(s.signal.dir, 'up');
  // El cierre lo da el reloj (un globo tapa la gráfica): todavía no hay con qué calificar.
  s = read(t, 112, 15200, clock(0, { closedNow: true, inferred: true }), { clean: false });
  assert.equal(s.phase, 'signal');
  assert.equal(s.remainingMs, 0);
  assert.deepEqual(tally(s), [0, 0, 0]);
  // Dos segundos después se destapa. La vela cerró en 114; el precio de este instante ya va en 109.
  s = read(t, 109, 17300, clock(2100, { closeRow: row(114) }));
  assert.deepEqual(tally(s), [1, 0, 0]); // cuenta el cierre (114 > 112), no el precio de después
  assert.equal(s.lastResult, 'acertó');
});

test('si la gráfica sigue tapada casi una vela entera, queda sin medir: no se inventa', () => {
  const t = createTimedTracker();
  t.predict();
  read(t, 112, 0, clock(1000));
  let s = read(t, 112, 15200, clock(0, { closedNow: true, inferred: true }), { clean: false });
  s = read(t, 112, 27000, clock(11800), { clean: false });
  assert.equal(s.phase, 'signal'); // 11.8 s: todavía dentro de la espera (12 s para velas de 15 s)
  s = read(t, 112, 27400, clock(12200), { clean: false });
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /no se pudo medir/);
  assert.deepEqual(tally(s), [0, 0, 0]);
});

test('sin reloj de vela: espera a VER un cambio de vela y esa señal se califica a los segundos de siempre', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 0, noClock());
  assert.equal(s.phase, 'waiting');
  assert.equal(s.clockKnown, false);
  assert.equal(s.remainingMs, 0); // no hay cuenta regresiva que mostrar
  s = read(t, 112, 5000, noClock({ closedNow: true }));
  assert.equal(s.phase, 'signal');
  assert.equal(s.untilClose, false);
  assert.equal(s.remainingMs, CYCLE);
  s = read(t, 115, 10000, noClock());
  assert.deepEqual(tally(s), [1, 0, 0]);
});

test('en automático (sin botón) nada cambia: señal al momento y calificada a los segundos', () => {
  const t = createTimedTracker();
  let s = read(t, 112, 0, clock(9000), { manual: false });
  assert.equal(s.phase, 'signal');
  assert.equal(s.untilClose, false);
  s = read(t, 115, 5000, clock(14000), { manual: false });
  assert.deepEqual(tally(s), [1, 0, 0]);
});

test('Reiniciar cancela la espera', () => {
  const t = createTimedTracker();
  t.predict();
  assert.equal(read(t, 112, 0, clock(9000)).phase, 'waiting');
  t.reset();
  const s = read(t, 112, 1000, clock(10000));
  assert.equal(s.phase, 'idle');
  assert.equal(s.ready, true);
});
