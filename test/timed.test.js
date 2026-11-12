const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, relativePrice, findReference, decide, tickMomentum } = require('../src/timed');
const { chain } = require('./helpers');

// En las velas de prueba el "precio" es un número; en pantalla la fila de la línea
// de precio es su negativo (más arriba en pantalla = fila menor = precio mayor).
const row = (price, scale = 1) => -price * scale;

// Tendencia alcista y vela en curso de cuerpo fuerte verde, de tamaño normal.
const UP_MOVES = [3, -2, 4, -3, 3, -2, 4, -3, 3, 4];
// Lo mismo hacia abajo.
const DOWN_MOVES = [-3, 2, -4, 3, -3, 2, -4, 3, -3, -4];
// Velas de lado y vela en curso sin fuerza (0 votos): solo cuenta el precio.
const FLAT_MOVES = [2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1];
const UP = chain(UP_MOVES);
const DOWN = chain(DOWN_MOVES);
const FLAT = chain(FLAT_MOVES);
const CYCLE = 5000;
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
const step = (t, candles, price, now, extra = {}) =>
  t.update({ candles, priceY: row(price, extra.scale || 1), now, cycleMs: CYCLE, payout: 85, pauseMs: extra.pauseMs || 0 });

test('da una señal, espera el ciclo y la califica con el movimiento del precio', () => {
  const t = createTimedTracker();
  let s = step(t, UP, 112, 0);
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.phase, 'signal');
  assert.equal(s.remainingMs, 5000);

  // A media espera no se califica nada aunque el precio se mueva
  s = step(t, UP, 115, 2500);
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(s.remainingMs, 2500);

  // Terminó y el precio quedó más arriba -> acertó
  s = step(t, UP, 115, 5000);
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.lastResult, 'acertó');
  assert.equal(s.signal.dir, 'up');

  // Siguiente ciclo: el precio bajó -> falló
  s = step(t, UP, 113, 10000);
  assert.deepEqual(tally(s), [1, 1, 0]);
  assert.equal(s.lastResult, 'falló');
});

test('precio igual = empate; hacia abajo se califica igual que hacia arriba', () => {
  const t = createTimedTracker();
  let s = step(t, DOWN, 88, 0);
  assert.equal(s.signal.dir, 'down');
  s = step(t, DOWN, 88, 5000);
  assert.deepEqual(tally(s), [0, 0, 1]);
  assert.equal(s.signal.dir, 'down');
  s = step(t, DOWN, 86, 10000); // bajó
  assert.deepEqual(tally(s), [1, 0, 1]);
});

test('con pausa: analiza, da la señal, la califica y vuelve a analizar (nunca dos señales pegadas)', () => {
  const t = createTimedTracker();
  const opts = { pauseMs: 5000 };

  // Arranca analizando: todavía no hay señal
  let s = step(t, UP, 112, 0, opts);
  assert.equal(s.phase, 'analysis');
  assert.equal(s.signal, null);
  assert.equal(s.remainingMs, 5000);
  s = step(t, UP, 113, 2500, opts);
  assert.equal(s.phase, 'analysis');
  assert.equal(s.remainingMs, 2500);

  // Termina el análisis -> señal por 5 segundos
  s = step(t, UP, 114, 5000, opts);
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.remainingMs, 5000);
  s = step(t, UP, 115, 7000, opts);
  assert.equal(s.phase, 'signal');
  assert.equal(s.remainingMs, 3000);

  // Termina la señal -> se califica y NO sale otra señal: vuelve a analizar 5 segundos
  s = step(t, UP, 116, 10000, opts);
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.phase, 'analysis');
  assert.equal(s.signal, null);
  s = step(t, UP, 116, 14000, opts);
  assert.equal(s.phase, 'analysis');

  // Y después del análisis, la siguiente señal
  s = step(t, UP, 117, 15000, opts);
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
});

test('lo observado durante el análisis cuenta para la señal', () => {
  // Velas de lado y vela en curso sin fuerza: solo el precio puede dar señal.
  const t = createTimedTracker();
  const opts = { pauseMs: 5000 };
  step(t, FLAT, 100, 0, opts); // análisis
  let s = step(t, FLAT, 101, 5000, opts); // subió durante el análisis: 1 voto, no alcanza
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, null);
  s = step(t, FLAT, 102, 10000, opts); // subió otra vez (señal en ESPERAR: no se califica)
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(s.phase, 'analysis');
  s = step(t, FLAT, 103, 15000, opts); // tercer tramo subiendo: racha -> ARRIBA
  assert.equal(s.signal.dir, 'up');
  assert.match(s.signal.reason, /3 tramos seguidos hacia arriba/);
});

test('sigue midiendo aunque la gráfica cambie de escala, se desplace o cierre una vela', () => {
  // Cambio de escala vertical durante la espera: el precio subió de 112 a 114
  let t = createTimedTracker();
  step(t, UP, 112, 0);
  let s = step(t, chain(UP_MOVES, 1.4), 114, 5000, { scale: 1.4 });
  assert.deepEqual(tally(s), [1, 0, 0]);

  // El precio NO se movió: con la escala nueva la línea está en otra fila y debe salir empate
  t = createTimedTracker();
  step(t, UP, 112, 0);
  s = step(t, chain(UP_MOVES, 1.4), 112, 5000, { scale: 1.4 });
  assert.deepEqual(tally(s), [0, 0, 1]);

  // Desplazamiento horizontal: las velas cambian de x pero son las mismas
  t = createTimedTracker();
  step(t, UP, 112, 0);
  s = step(t, UP.map((c) => ({ ...c, x0: c.x0 - 37, x1: c.x1 - 37 })), 110, 5000);
  assert.deepEqual(tally(s), [0, 1, 0]);

  // La vela en curso cerró y hay otra nueva
  t = createTimedTracker();
  step(t, UP, 112, 0);
  s = step(t, chain([...UP_MOVES, 2]), 118, 5000);
  assert.deepEqual(tally(s), [1, 0, 0]);
});

test('si la gráfica es otra, la señal queda sin calificar', () => {
  const t = createTimedTracker();
  step(t, UP, 112, 0);
  const s = step(t, chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4, 4]), 100, 5000);
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.match(s.lastResult, /no se pudo medir/);
});

test('sin línea de precio o sin velas no da señal', () => {
  const t = createTimedTracker();
  assert.equal(t.update({ candles: UP, priceY: null, now: 0, cycleMs: CYCLE, payout: 85 }).status, 'no-price');
  assert.equal(t.update({ candles: UP, priceY: null, now: 0, cycleMs: CYCLE, payout: 85 }).signal, null);
  assert.equal(t.update({ candles: [], priceY: -100, now: 0, cycleMs: CYCLE, payout: 85 }).status, 'no-chart');
});

test('votación: lo más reciente pesa más, igual hacia arriba que hacia abajo', () => {
  const up = { dir: 'up' };
  const down = { dir: 'down' };
  const side = { dir: null };
  const none = { vote: 0, text: 'sin fuerza' };
  const bull = { vote: 1, text: 'cuerpo fuerte verde' };
  const bear = { vote: -1, text: 'mecha larga arriba (rechazo)' };
  const falling = { vote: -2, text: 'bajando con fuerza', net: -6 };
  const rising = { vote: 2, text: 'subiendo con fuerza', net: 6 };

  // Las velas solas (1 voto) no alcanzan; la vela actual vale 2
  assert.equal(decide(up, none, []).dir, null);
  assert.equal(decide(side, bull, []).dir, 'up');
  assert.equal(decide(up, bull, []).dir, 'up');
  // La vela actual manda sobre la tendencia de las velas anteriores
  assert.equal(decide(up, bear, []).dir, null); // 1 - 2 = -1
  assert.equal(decide(up, bear, ['down']).dir, 'down'); // 1 - 2 - 1 = -2
  // Precio por tramos: un tramo vale 1 voto, una racha 2
  assert.equal(decide(up, none, ['up']).dir, 'up');
  assert.equal(decide(up, none, ['down']).dir, null);
  assert.equal(decide(up, none, ['down', 'down', 'down']).dir, null); // 1 - 2 = -1
  assert.equal(decide(side, none, ['down', 'down']).dir, 'down');
  // Precio ahora mismo (lectura a lectura): hasta 2 votos, y puede voltear la señal
  assert.equal(decide(up, none, [], { ticks: falling }).dir, null); // 1 - 2 = -1
  assert.equal(decide(up, none, ['down'], { ticks: falling }).dir, 'down'); // 1 - 2 - 1 = -2
  assert.equal(decide(down, none, ['up'], { ticks: rising }).dir, 'up');
  assert.equal(decide(side, none, [], { ticks: rising }).dir, 'up');

  const d = decide(up, bull, ['up', 'up'], { ticks: rising });
  assert.equal(d.confidence, 'alta');
  assert.match(d.reason, /Precio subiendo con fuerza, 2 tramos seguidos hacia arriba · vela actual: cuerpo fuerte verde · velas hacia arriba/);
  assert.equal(d.readings.price.text, 'subiendo con fuerza (2 tramos)');
  assert.equal(d.readings.price.lean, 'up');

  // Simetría: voltear todo da siempre la señal contraria
  const flipDir = { up: 'down', down: 'up' };
  const flipTicks = (k) => (k ? { vote: -k.vote, text: k.text, net: -k.net } : null);
  const cases = [
    [up, bull, ['up'], null], [up, none, ['down', 'down'], falling], [down, bear, [], null],
    [side, bull, ['up', 'flat'], rising], [up, bear, ['down', 'down'], null], [down, none, ['up'], rising],
    [side, none, ['up', 'up', 'up'], null], [up, none, [], falling],
  ];
  for (const [trend, pattern, moves, ticks] of cases) {
    const mirrored = decide(
      { dir: flipDir[trend.dir] || null },
      { vote: -pattern.vote, text: pattern.text },
      moves.map((m) => flipDir[m] || 'flat'),
      { ticks: flipTicks(ticks) },
    );
    assert.equal(mirrored.dir, flipDir[decide(trend, pattern, moves, { ticks }).dir] || null);
  }
});

test('movimiento del precio lectura a lectura', () => {
  const at = (ys, stepMs = 300) => ys.map((y, i) => ({ time: i * stepMs, y }));
  const now = (ys, stepMs = 300) => (ys.length - 1) * stepMs;
  const read = (ys) => tickMomentum(at(ys), now(ys));

  // Fila menor = más arriba en pantalla = precio mayor
  assert.deepEqual(read([100, 99, 98, 96, 95, 93]), { vote: 2, text: 'subiendo con fuerza', net: 7 });
  assert.deepEqual(read([100, 101, 103, 104, 106]), { vote: -2, text: 'bajando con fuerza', net: -6 });
  assert.equal(read([100, 99, 100, 99, 98]).vote, 1); // sube poco
  assert.equal(read([100, 98, 101, 97, 100, 96]).vote, 1); // sube a trompicones: sin "fuerza"
  assert.deepEqual(read([100, 100, 100, 100]), { vote: 0, text: 'quieto', net: 0 });
  assert.equal(read([100, 99]).text, 'sin lecturas'); // muy pocas lecturas
  // Solo cuentan los últimos 3 segundos: lo anterior se ignora
  const old = [...at([90, 92, 94, 96, 98, 100], 1000), { time: 8000, y: 100 }, { time: 8300, y: 100 }, { time: 8600, y: 100 }];
  assert.equal(tickMomentum(old, 8600).text, 'quieto');
});

test('el marcador sigue el precio lectura a lectura, aunque la gráfica cambie de escala', () => {
  const t = createTimedTracker();
  // Velas de lado; el precio sube en cada lectura (cada 300 ms)
  let s;
  for (let i = 0; i <= 10; i++) {
    s = t.update({ candles: FLAT, priceY: -100 - i, now: i * 300, cycleMs: 60000, payout: 85, manual: true });
  }
  assert.equal(s.ticks.length, 11);
  assert.equal(s.signal, null); // modo manual: nadie ha pedido predicción
  t.predict();
  s = t.update({ candles: FLAT, priceY: -111, now: 3300, cycleMs: 60000, payout: 85, manual: true });
  assert.equal(s.signal.dir, 'up');
  assert.match(s.signal.reason, /Precio subiendo con fuerza/);

  // Cambia la escala de la gráfica (pasa cuando el precio empuja a un nuevo máximo):
  // las lecturas anteriores se pasan a la escala nueva y el movimiento se sigue viendo.
  s = t.update({ candles: chain(FLAT_MOVES, 1.5), priceY: -112 * 1.5, now: 3600, cycleMs: 60000, payout: 85, manual: true });
  assert.equal(s.ticks.length, 13);
  const ys = s.ticks.map((k) => Math.round(k.y * 10) / 10);
  assert.equal(ys[0], -150); // la primera lectura (precio 100) en la escala nueva
  assert.equal(ys[12], -168);
  assert.ok(ys.every((y, i) => i === 0 || y < ys[i - 1]), JSON.stringify(ys)); // siempre subiendo

  // Otra gráfica distinta: las lecturas viejas ya no se reconocen y no se usan
  s = t.update({ candles: chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4, 4]), priceY: -100, now: 3900, cycleMs: 60000, payout: 85, manual: true });
  assert.equal(s.ticks.length, 1);
});

test('movimiento rápido que reescala la gráfica en cada lectura: se sigue detectando', () => {
  // La vela en curso crece en cada lectura y la gráfica se encoge para que quepa.
  const t = createTimedTracker();
  let s;
  for (let i = 0; i <= 10; i++) {
    const scale = 1 - i * 0.03;
    s = t.update({ candles: chain(FLAT_MOVES, scale), priceY: -(100 + i) * scale, now: i * 300, cycleMs: 60000, payout: 85, manual: true });
  }
  t.predict();
  s = t.update({ candles: chain(FLAT_MOVES, 0.67), priceY: -111 * 0.67, now: 3300, cycleMs: 60000, payout: 85, manual: true });
  assert.equal(s.ticks.length, 12);
  assert.match(s.signal.reason, /Precio subiendo con fuerza/);
  assert.equal(s.signal.dir, 'up');
});

test('precio relativo a las velas de referencia', () => {
  const reference = [
    { dir: 'up', open: 100, close: 104, high: 110, low: 90 },
    { dir: 'down', open: 104, close: 101, high: 106, low: 95 },
  ];
  assert.equal(relativePrice(row(90), reference).value, 0);
  assert.equal(relativePrice(row(110), reference).value, 1);
  assert.equal(relativePrice(row(100), reference).value, 0.5);
  assert.equal(relativePrice(row(100), reference).pixel, 1 / 20);

  const completed = UP.slice(0, -1);
  const ref = completed.slice(-4);
  assert.deepEqual(findReference(ref, completed), ref);
  assert.equal(findReference(ref, chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4])), null);
});
