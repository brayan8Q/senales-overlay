const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

// SEGUIMIENTO con martingala: la señal no se suelta. Mientras dura se dice cómo va; si va perdiendo
// en su tramo final se avisa hacia dónde saldría la martingala; y si termina perdiendo, la
// martingala sale en ese mismo instante, hacia donde va el precio.
const row = (price) => -price;
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // las reglas dan ARRIBA; la vela en curso cierra en 112
const FLAT = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1]); // sin lado: ESPERAR
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
const make = (martin, candles = UP) => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now) => t.update({ candles, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, martin });
  return { t, read };
};

test('sin seguimiento todo sigue igual: la señal que pierde termina y el panel queda en reposo', () => {
  const { read } = make(0);
  let s = read(112, 0);
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.follow.max, 0);
  s = read(110, 3000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.follow, null);
});

test('durante la señal se dice cómo va: ganando, perdiendo o igual', () => {
  const { read } = make(1);
  let s = read(112, 0);
  assert.deepEqual(s.follow, { state: 'igual', level: 0, max: 1, next: null });
  s = read(113, 600);
  assert.equal(s.follow.state, 'ganando');
  assert.equal(s.follow.next, null);
  s = read(111, 1200);
  assert.equal(s.follow.state, 'perdiendo');
  assert.equal(s.follow.next, null); // todavía no es el tramo final (le quedan 1.8 s)
});

test('si va perdiendo en el tramo final se avisa la martingala y hacia dónde saldría', () => {
  const { read } = make(1);
  read(112, 0);
  read(111.5, 600);
  read(111, 1200);
  const s = read(110, 1800); // le quedan 1.2 s y el precio viene bajando
  assert.equal(s.follow.state, 'perdiendo');
  assert.deepEqual(s.follow.next, { level: 1, dir: 'down' });
  // Si se recupera antes de terminar, el aviso se quita.
  assert.equal(read(113, 2400).follow.next, null);
});

test('la señal pierde: la martingala sale en ese mismo instante, hacia donde va el precio', () => {
  const { t, read } = make(1);
  read(112, 0);
  read(111, 1000);
  read(110.5, 2000);
  let s = read(110, 3000); // perdió: ARRIBA desde 112 y terminó en 110
  assert.equal(s.lastResult, 'falló');
  assert.deepEqual(tally(s), [0, 1, 0]);
  assert.equal(s.phase, 'signal'); // sin pausa ni análisis: ya hay otra entrada
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.martin, 1);
  assert.equal(s.signal.dir, 'down'); // el precio va bajando
  assert.match(s.signal.reason, /^Martingala 1: la señal ARRIBA perdió y ahora el precio va bajando/);
  assert.equal(s.remainingMs, 3000);
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false); // no se encima otra predicción
  assert.deepEqual(s.follow, { state: 'igual', level: 1, max: 1, next: null });
  // La martingala se mide igual que cualquier señal, desde el precio de ese instante.
  s = read(108, 6000);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'acertó');
  assert.deepEqual(tally(s), [1, 1, 0]);
  assert.equal(s.ready, true);
  assert.equal(t.predict(), true);
});

test('la martingala sigue lo que se está escaneando: si el precio ya rebotó, sale hacia el rebote', () => {
  const { read } = make(1);
  read(112, 0);
  read(108, 800);
  read(107, 1600);
  read(109, 2300);
  const s = read(110.5, 3000); // perdió (110.5 < 112), pero el precio giró desde el piso y viene subiendo
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.dir, 'up');
  assert.match(s.signal.reason, /giró hacia arriba desde el piso/);
});

test('sin movimiento claro en los últimos segundos, sale hacia donde se fue el precio en la operación perdida', () => {
  const { read } = make(1);
  read(112, 0);
  const s = read(111, 3000); // solo dos lecturas: no hay "movimiento ahora" que seguir
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.dir, 'down');
  assert.match(s.signal.reason, /el precio se fue hacia abajo/);
});

test('tope de martingalas: con 1 se detiene tras la primera; con 2 da una segunda', () => {
  let { read } = make(1);
  read(112, 0);
  read(110, 3000); // martingala 1 hacia abajo
  let s = read(111, 6000); // también perdió
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'falló');
  assert.deepEqual(tally(s), [0, 2, 0]);

  ({ read } = make(2));
  read(112, 0);
  s = read(110, 3000);
  assert.equal(s.signal.martin, 1);
  s = read(111, 6000); // la primera martingala perdió: sale la segunda
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.martin, 2);
  assert.match(s.signal.reason, /^Martingala 2: la señal ABAJO perdió/);
  assert.equal(s.follow.level, 2);
  s = read(112, 9000);
  assert.equal(s.phase, 'idle'); // gane o pierda, no hay tercera
});

test('si la señal gana, empata o no dio lado, no hay martingala', () => {
  let { read } = make(2);
  read(112, 0);
  let s = read(114, 3000);
  assert.equal(s.lastResult, 'acertó');
  assert.equal(s.phase, 'idle');

  ({ read } = make(2));
  read(112, 0);
  s = read(112, 3000);
  assert.equal(s.lastResult, 'empate');
  assert.equal(s.phase, 'idle');

  ({ read } = make(2, FLAT));
  s = read(101, 0);
  assert.equal(s.signal.dir, null);
  assert.equal(s.follow, null);
  s = read(99, 3000);
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /^no dio predicción/);
});

test('la martingala también trae su zona de entrada', () => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now) => t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, martin: 1, suggest: true });
  read(112, 0);
  const s = read(110, 3000);
  assert.equal(s.signal.source, 'martingala');
  assert.ok(s.entry && s.entry.zone, 'trae su zona de dos líneas');
  assert.equal(s.entry.row, row(110)); // la referencia es el precio del instante de la martingala
});
