/** Globos de resultado de la plataforma: detección sobre recortes REALES y conteo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { findResultBadges, viewJumped, createBadgeCounter } = require('../src/badges');
const { chain } = require('./helpers');

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const badgesIn = (name) => {
  const png = load(name);
  return findResultBadges(png.data, png.width, png.height);
};

test('reconoce el globo verde como ganada y el rojo como perdida', () => {
  const win = badgesIn('globo_ganada.png');
  assert.equal(win.length, 1, JSON.stringify(win));
  assert.equal(win[0].result, 'win');

  const loss = badgesIn('globo_perdida.png');
  assert.equal(loss.length, 1, JSON.stringify(loss));
  assert.equal(loss[0].result, 'loss');
});

test('en gráficas completas: encuentra el globo "$0" y no inventa otros', () => {
  // Esta captura tiene un globo "$0" rojo sobre la gráfica.
  const live = badgesIn('grafica_real2.png');
  assert.equal(live.length, 1, JSON.stringify(live));
  assert.equal(live[0].result, 'loss');
  // Estas no tienen ninguno.
  assert.deepEqual(badgesIn('grafica_real.png'), []);
  assert.deepEqual(badgesIn('grafica_real3.png'), []);
});

test('cada globo se cuenta una sola vez', () => {
  const counter = createBadgeCounter();
  const win = { x: 300, y: 200, result: 'win' };
  const loss = { x: 320, y: 260, result: 'loss' };
  let t = 0;
  const tick = (badges, jumped = false) => counter.update(badges, (t += 500), jumped);
  const score = (s) => [s.wins, s.losses];

  // Lo que ya estaba en pantalla al empezar no se cuenta.
  assert.deepEqual(score(tick([loss])), [0, 0]);
  assert.deepEqual(score(tick([loss])), [0, 0]);

  // Aparece un globo verde: se cuenta al verlo dos lecturas seguidas, y solo una vez.
  assert.deepEqual(score(tick([loss, win])), [0, 0]);
  let s = tick([loss, win]);
  assert.deepEqual(score(s), [1, 0]);
  assert.equal(s.last, 'GANADA');
  for (let i = 0; i < 6; i++) s = tick([loss, win]);
  assert.deepEqual(score(s), [1, 0]);

  // La gráfica se desplaza despacio: sigue siendo el mismo globo.
  for (let i = 1; i <= 10; i++) s = tick([{ ...win, x: win.x - i * 2 }]);
  assert.deepEqual(score(s), [1, 0]);

  // Desaparecen todos y más tarde sale uno rojo nuevo en otro sitio.
  for (let i = 0; i < 20; i++) tick([]);
  tick([{ x: 400, y: 150, result: 'loss' }]);
  s = tick([{ x: 400, y: 150, result: 'loss' }]);
  assert.deepEqual(score(s), [1, 1]);
  assert.equal(s.last, 'PERDIDA');
});

test('un destello de una sola lectura no cuenta; un salto de la gráfica tampoco', () => {
  const counter = createBadgeCounter();
  let t = 0;
  const tick = (badges, jumped = false) => counter.update(badges, (t += 500), jumped);
  tick([]);
  tick([{ x: 100, y: 100, result: 'win' }]); // se ve una vez y desaparece
  let s = tick([]);
  assert.deepEqual([s.wins, s.losses], [0, 0]);

  // Hay un globo ya contado; la gráfica cambia de escala y aparece en otro sitio.
  tick([{ x: 200, y: 200, result: 'loss' }]);
  s = tick([{ x: 200, y: 200, result: 'loss' }]);
  assert.deepEqual([s.wins, s.losses], [0, 1]);
  s = tick([{ x: 200, y: 320, result: 'loss' }], true);
  s = tick([{ x: 200, y: 320, result: 'loss' }]);
  assert.deepEqual([s.wins, s.losses], [0, 1]);

  counter.reset();
  s = tick([{ x: 200, y: 320, result: 'loss' }]);
  assert.deepEqual([s.wins, s.losses], [0, 0]);
});

test('un globo que aparece justo cuando la vista salta SÍ se cuenta (aviso "Trade closed" tapando velas)', () => {
  // Caso real: al cerrar la operación la plataforma tapa velas con su aviso y eso parece un salto.
  let counter = createBadgeCounter();
  let t = 0;
  const tick = (badges, jumped = false) => counter.update(badges, (t += 300), jumped);
  const win = (x, y = 100) => ({ x, y, result: 'win' });
  const loss = (x, y = 100) => ({ x, y, result: 'loss' });

  // a) El globo aparece en la misma lectura que el salto
  tick([]);
  let s = tick([win(600)], true);
  assert.deepEqual([s.wins, s.losses], [0, 0]); // todavía es una sola lectura
  s = tick([win(600)], true); // el aviso sigue ahí: otro "salto"
  assert.deepEqual([s.wins, s.losses], [1, 0]);
  s = tick([win(598)]);
  s = tick([win(540, 180)], true); // la vista vuelve a saltar: es el mismo globo, no se repite
  assert.deepEqual([s.wins, s.losses], [1, 0]);

  // b) Aparece una lectura antes del salto
  counter = createBadgeCounter();
  t = 0;
  tick([]);
  tick([win(600)]);
  s = tick([win(520, 140)], true);
  assert.deepEqual([s.wins, s.losses], [1, 0]);

  // c) Ya había una ganada contada; durante un salto aparece una perdida nueva y otra ganada a su derecha
  counter = createBadgeCounter();
  t = 0;
  tick([]);
  tick([win(300)]);
  s = tick([win(300)]);
  assert.deepEqual([s.wins, s.losses], [1, 0]);
  s = tick([win(240, 150), win(600, 90), loss(450, 200)], true);
  s = tick([win(240, 150), win(600, 90), loss(450, 200)]);
  assert.deepEqual([s.wins, s.losses], [2, 1]);

  // d) Con salto y el globo viejo saliendo por la izquierda, el que queda no se cuenta otra vez
  s = tick([win(540, 90), loss(390, 200)], true);
  s = tick([win(540, 90), loss(390, 200)]);
  assert.deepEqual([s.wins, s.losses], [2, 1]);
});

test('detecta saltos de la vista pero no el desplazamiento normal', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3]);
  assert.equal(viewJumped(candles, candles), false);
  assert.equal(viewJumped(candles, candles.map((c) => ({ ...c, x0: c.x0 - 1, x1: c.x1 - 1 }))), false);
  assert.equal(viewJumped(candles, [...candles, ...chain([2], 1, 104)]), false); // cerró una vela nueva
  assert.equal(viewJumped(candles, chain([3, -2, 4, -3, 3, -2, 4, -3], 1.5)), true); // otra escala
  assert.equal(viewJumped(null, candles), true);
});
