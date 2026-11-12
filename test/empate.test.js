/** Globo amarillo de la plataforma = empate (devuelve lo apostado). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { findResultBadges, createBadgeCounter } = require('../src/badges');
const { summarize } = require('../src/score');

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const results = (name) => {
  const png = load(name);
  return findResultBadges(png.data, png.width, png.height).map((b) => b.result);
};

test('captura real del globo amarillo "+$2": se reconoce como empate', () => {
  assert.deepEqual(results('globo_empate.png'), ['tie']);
  // Y los otros dos siguen saliendo como antes
  assert.deepEqual(results('globo_ganada.png'), ['win']);
  assert.deepEqual(results('globo_perdida.png'), ['loss']);
});

test('el empate se cuenta aparte: ni ganada ni perdida', () => {
  const counter = createBadgeCounter();
  let t = 0;
  const tick = (badges, jumped = false) => counter.update(badges, (t += 300), jumped);
  tick([]);
  tick([{ x: 300, y: 100, result: 'tie' }]);
  let s = tick([{ x: 300, y: 100, result: 'tie' }]);
  assert.deepEqual([s.wins, s.losses, s.ties, s.last], [0, 0, 1, 'EMPATE']);
  // El mismo globo no se cuenta dos veces, ni si la vista salta
  s = tick([{ x: 298, y: 100, result: 'tie' }]);
  s = tick([{ x: 240, y: 160, result: 'tie' }], true);
  assert.equal(s.ties, 1);
  // Luego una ganada y una perdida, cada una en su cuenta
  tick([{ x: 240, y: 160, result: 'tie' }, { x: 500, y: 90, result: 'win' }]);
  s = tick([{ x: 240, y: 160, result: 'tie' }, { x: 500, y: 90, result: 'win' }]);
  assert.deepEqual([s.wins, s.losses, s.ties], [1, 0, 1]);
  // Un empate que aparece justo con un salto de la vista también cuenta
  tick([{ x: 180, y: 160, result: 'tie' }, { x: 440, y: 90, result: 'win' }, { x: 600, y: 120, result: 'tie' }], true);
  s = tick([{ x: 180, y: 160, result: 'tie' }, { x: 440, y: 90, result: 'win' }, { x: 600, y: 120, result: 'tie' }]);
  assert.deepEqual([s.wins, s.losses, s.ties], [1, 0, 2]);

  counter.reset();
  s = tick([]);
  assert.deepEqual([s.wins, s.losses, s.ties], [0, 0, 0]);
});

test('los empates no entran en el porcentaje de aciertos', () => {
  const summary = summarize({ wins: 6, losses: 4, ties: 3 }, 92);
  assert.equal(summary.ties, 3);
  assert.equal(summary.hitRate, 60); // 6 de 10: los 3 empates no cuentan
});
