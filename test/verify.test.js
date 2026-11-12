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

test('al cerrar una vela hay un instante sin verificar y luego vuelve', () => {
  const v = createStabilityCheck();
  for (let i = 0; i < 3; i++) v.check(candles);
  const next = chain([...MOVES, 2]).slice(1); // cerró una vela: todas se corren un lugar
  assert.equal(v.check(next), false);
  assert.equal(v.check(next), false);
  assert.equal(v.check(next), true);
});

test('las lecturas dan la fila del soporte y la resistencia, para dibujarlos', () => {
  const list = chain([-3, -4, -3, 4, 4, 3, -4, -4, -3, 4, 3, 4, -3, -3, -4]);
  const r = computeReadings({ candles: list.slice(0, -1), forming: list[list.length - 1], time: Date.UTC(2026, 10, 12, 13) });
  assert.equal(typeof r.rows.support, 'number');
  // El soporte queda por debajo del precio (en pantalla: fila mayor que la del cierre)
  assert.ok(r.rows.support > -list[list.length - 1].close, JSON.stringify(r.rows));
});
