/** Lectura verificada: varias lecturas seguidas de las velas deben coincidir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStabilityCheck, sameRead } = require('../src/quality');
const { computeReadings } = require('../src/readings');
const { chain } = require('./helpers');

const MOVES = [3, -2, 4, -3, 3, -2, 4, -3, 3, 4, -2, 5];
const candles = chain(MOVES);
/** La misma gráfica desplazada y con otra escala (lo que hace la plataforma todo el tiempo). */
const moved = (list, scale, dx, dy) =>
  list.map((c) => ({ ...c, x0: c.x0 + dx, x1: c.x1 + dx, open: c.open * scale + dy, close: c.close * scale + dy, high: c.high * scale + dy, low: c.low * scale + dy }));

test('tres lecturas iguales seguidas = verificada', () => {
  const v = createStabilityCheck();
  assert.equal(v.check(candles), false); // una sola
  assert.equal(v.check(candles), false); // dos
  assert.equal(v.check(candles), true); // tres iguales
  assert.equal(v.check(candles), true);
});

test('que la gráfica se desplace o cambie de escala no rompe la verificación', () => {
  const v = createStabilityCheck();
  v.check(candles);
  v.check(moved(candles, 1, -3, 0)); // se desplazó 3 px
  assert.equal(v.check(moved(candles, 1.3, -6, 40)), true); // y además cambió de escala
  // La vela en curso cambia en cada lectura: tampoco importa
  const growing = candles.map((c, i) => (i === candles.length - 1 ? { ...c, close: c.close + 9, high: c.high + 9 } : c));
  assert.equal(v.check(growing), true);
});

test('una lectura rara no se da por buena; al volver a coincidir, sí', () => {
  const v = createStabilityCheck();
  v.check(candles);
  v.check(candles);
  assert.equal(v.check(candles), true);
  // Falta una vela (algo la tapó)
  const missing = candles.filter((_, i) => i !== 5);
  assert.equal(v.check(missing), false);
  assert.equal(sameRead(candles, missing), false);
  // Una vela salió deformada (media tapada: la mitad de alta)
  const bent = candles.map((c, i) => (i === 4 ? { ...c, high: c.low + (c.high - c.low) / 2 } : c));
  assert.equal(sameRead(candles, bent), false);
  // Una vela cambió de color
  const flipped = candles.map((c, i) => (i === 7 ? { ...c, dir: c.dir === 'up' ? 'down' : 'up' } : c));
  assert.equal(sameRead(candles, flipped), false);
  // Vuelve la lectura buena: hacen falta tres seguidas otra vez
  assert.equal(v.check(candles), false);
  assert.equal(v.check(candles), false);
  assert.equal(v.check(candles), true);
});

test('al cerrar una vela el seguimiento NO se suelta', () => {
  const v = createStabilityCheck();
  for (let i = 0; i < 3; i++) v.check(candles);
  const next = chain([...MOVES, 2]).slice(1); // cerró una vela: todas se corren un lugar
  assert.equal(v.check(next), true);
  assert.equal(v.check(next), true);
  assert.equal(v.check(next), true);
  // Cerró una vela y además NO salió ninguna por la izquierda (hay una vela más a la vista)
  const longer = chain([...MOVES, 2, -3]).slice(1);
  assert.equal(v.check(longer), true);
});

test('una vela que sale por el borde izquierdo (o se ve cortada) no suelta el seguimiento', () => {
  const v = createStabilityCheck();
  for (let i = 0; i < 3; i++) v.check(candles);
  // La del borde izquierdo se ve cortada: la mitad de alta
  const cut = candles.map((c, i) => (i === 0 ? { ...c, high: c.low + (c.high - c.low) / 2 } : c));
  assert.equal(v.check(cut), true);
  // Y luego desaparece
  assert.equal(v.check(candles.slice(1)), true);
  assert.equal(v.check(candles.slice(1)), true);
});

test('con el seguimiento nuevo, una vela reciente tapada o deformada sigue sin darse por buena', () => {
  const v = createStabilityCheck();
  for (let i = 0; i < 3; i++) v.check(candles);
  // Falta la penúltima vela cerrada (un globo la tapó)
  const hole = candles.filter((_, i) => i !== candles.length - 3);
  assert.equal(v.check(hole), false);
  // Faltan dos velas de golpe
  assert.equal(sameRead(candles, candles.slice(2)), false);
  // La última cerrada salió deformada
  const bent = candles.map((c, i) => (i === candles.length - 2 ? { ...c, high: c.high + (c.high - c.low) } : c));
  assert.equal(sameRead(candles, bent), false);
});

test('las lecturas dan la fila del soporte y la resistencia, para dibujarlos', () => {
  const list = chain([-3, -4, -3, 4, 4, 3, -4, -4, -3, 4, 3, 4, -3, -3, -4]);
  const r = computeReadings({ candles: list.slice(0, -1), forming: list[list.length - 1], time: Date.UTC(2026, 10, 12, 13) });
  assert.equal(typeof r.rows.support, 'number');
  // El soporte queda por debajo del precio (en pantalla: fila mayor que la del cierre)
  assert.ok(r.rows.support > -list[list.length - 1].close, JSON.stringify(r.rows));
});
