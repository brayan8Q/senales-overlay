/** Las 8 lecturas del panel y cómo cuentan en la decisión. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeReadings, findLevels, sessionAt } = require('../src/readings');
const { decide } = require('../src/timed');
const { describeChart } = require('../src/ai');
const { chain } = require('./helpers');

const NOON_UTC = Date.UTC(2026, 10, 11, 13, 30);
const read = (candles, extra = {}) =>
  computeReadings({ candles: candles.slice(0, -1), forming: candles[candles.length - 1], time: NOON_UTC, ...extra });
const byKey = (r) => Object.fromEntries(r.items.map((item) => [item.key, item]));
/** La misma gráfica volteada (lo que subía ahora baja). */
const flip = (candles) =>
  candles.map((c) => ({ ...c, dir: c.dir === 'up' ? 'down' : c.dir === 'down' ? 'up' : 'flat', open: -c.open, close: -c.close, high: -c.low, low: -c.high }));

// Sube con retrocesos: 3 pasos arriba, 1 abajo
const RISING = chain(Array.from({ length: 40 }, (_, i) => (i % 4 === 3 ? -2 : 3)));
// Zigzag sin avance
const SIDEWAYS = chain(Array.from({ length: 40 }, (_, i) => (i % 2 ? -3 : 3)));

test('son 8 lecturas, en el orden del panel', () => {
  const r = read(RISING);
  assert.deepEqual(r.items.map((i) => i.key), ['trend', 'ema', 'momentum', 'rsi', 'move', 'level', 'session', 'summary']);
  for (const item of r.items) assert.ok(item.name && item.text && item.detail, item.key);
});

test('gráfica que sube: tendencia, EMA y momentum hacia arriba; volteada, hacia abajo', () => {
  const up = byKey(read(RISING));
  assert.equal(up.trend.lean, 'up');
  assert.equal(up.trend.name, 'Tendencia · 12 velas');
  assert.equal(up.ema.lean, 'up');
  assert.equal(up.momentum.lean, 'up');
  assert.equal(up.summary.lean, 'up');
  assert.ok(read(RISING).vote >= 1);

  const down = byKey(read(flip(RISING)));
  assert.equal(down.trend.lean, 'down');
  assert.equal(down.ema.lean, 'down');
  assert.equal(down.momentum.lean, 'down');
  assert.equal(down.rsi.value, 100 - up.rsi.value);
  assert.equal(read(flip(RISING)).vote, -read(RISING).vote);
});

test('gráfica de lado: tendencia lateral y sin votos de contexto', () => {
  const r = byKey(read(SIDEWAYS));
  assert.equal(r.trend.lean, 'flat');
  assert.equal(r.trend.text, 'lateral');
});

test('EMA: usa 50/200 solo cuando hay 200 velas; antes, el par más largo que alcance y lo dice', () => {
  const steps = (n) => chain(Array.from({ length: n }, (_, i) => (i % 4 === 3 ? -2 : 3)));
  assert.equal(byKey(read(steps(8))).ema.text, 'faltan velas');
  assert.equal(byKey(read(steps(15))).ema.name, 'EMA 5/10');
  assert.equal(byKey(read(steps(30))).ema.name, 'EMA 9/21');
  assert.equal(byKey(read(steps(60))).ema.name, 'EMA 12/50');
  assert.equal(byKey(read(steps(120))).ema.name, 'EMA 25/100');
  const full = byKey(read(steps(210))).ema;
  assert.equal(full.name, 'EMA 50/200');
  assert.equal(full.lean, 'up');
  assert.match(byKey(read(steps(30))).ema.detail, /Pasa a 50\/200 al juntar 200/);

  // Cruce: una subida larga seguida de una caída fuerte deja la media rápida por debajo
  const crossed = chain([...Array.from({ length: 30 }, () => 2), ...Array.from({ length: 14 }, () => -5)]);
  assert.equal(byKey(read(crossed)).ema.lean, 'down');
});

test('RSI: los extremos votan en contra (se espera regreso)', () => {
  const allUp = byKey(read(chain(Array.from({ length: 20 }, () => 3))));
  assert.equal(allUp.rsi.value, 100);
  assert.equal(allUp.rsi.vote, -1);
  assert.match(allUp.rsi.text, /sobrecompra/);
  const allDown = byKey(read(chain(Array.from({ length: 20 }, () => -3))));
  assert.equal(allDown.rsi.value, 0);
  assert.equal(allDown.rsi.vote, 1);
  const middle = byKey(read(SIDEWAYS));
  assert.equal(middle.rsi.vote, 0);
});

test('nivel abajo: encuentra el soporte más cercano y cuántas veces se tocó', () => {
  // Dos caídas hasta ~90 con rebote, y ahora el precio vuelve a bajar hasta cerca de ahí
  const moves = [-3, -4, -3, 4, 4, 3, -4, -4, -3, 4, 3, 4, -3, -3, -4];
  const candles = chain(moves);
  const { supports, resistances } = findLevels(candles.slice(0, -1), 5);
  assert.equal(supports.length, 1);
  assert.equal(supports[0].touches, 2);
  assert.ok(resistances.length >= 1);

  const r = byKey(read(candles));
  assert.equal(r.level.support.touches, 2);
  assert.ok(r.level.support.distance <= 0.5, JSON.stringify(r.level.support));
  assert.equal(r.level.vote, 1); // pegado al soporte: posible rebote
  assert.match(r.level.detail, /Soporte a .* velas por debajo \(2 toques\)/);

  // Volteada: pegado a la resistencia, voto hacia abajo
  const mirrored = byKey(read(flip(candles)));
  assert.equal(mirrored.level.vote, -1);

  // Precio por debajo de todo lo visto: no hay soporte
  const falling = byKey(read(chain(Array.from({ length: 20 }, () => -3))));
  assert.equal(falling.level.text, 'en mínimos');
  assert.equal(falling.level.vote, 0);
});

test('movimiento en 1 minuto: cuánto osciló el precio, en tamaños de vela', () => {
  const candles = SIDEWAYS; // vela típica: mide 3 de cuerpo + mechas
  const few = byKey(read(candles, { prices: [{ time: NOON_UTC - 2000, value: 100 }, { time: NOON_UTC, value: 101 }] }));
  assert.equal(few.move.text, 'midiendo…');

  const prices = Array.from({ length: 61 }, (_, i) => ({ time: NOON_UTC - (60 - i) * 1000, value: 100 + (i % 2 ? 4 : -4) + i * 0.1 }));
  const r = byKey(read(candles, { prices }));
  assert.equal(r.move.name, 'Mov. 1 min');
  assert.match(r.move.text, /^±\d+(\.\d)? velas$/);
  assert.equal(r.move.vote, 0); // mide cuánto se mueve, no hacia dónde
  // Lo de hace más de un minuto no cuenta
  const old = [{ time: NOON_UTC - 90000, value: 500 }, ...prices];
  assert.equal(byKey(read(candles, { prices: old })).move.text, r.move.text);
});

test('sesión: por la hora, y en OTC se avisa que no aplica; nunca vota', () => {
  assert.equal(sessionAt(Date.UTC(2026, 10, 11, 3)).text, 'Asia');
  assert.equal(sessionAt(Date.UTC(2026, 10, 11, 9)).text, 'Londres');
  assert.equal(sessionAt(Date.UTC(2026, 10, 11, 13)).text, 'Londres + NY');
  assert.equal(sessionAt(Date.UTC(2026, 10, 11, 18)).text, 'Nueva York');
  assert.equal(sessionAt(Date.UTC(2026, 10, 11, 13), 'AED/CNY OTC').text, 'OTC · 24 h');
  assert.equal(byKey(read(RISING, { asset: 'AED/CNY OTC' })).session.vote, 0);
});

test('momentum muestra cómo va el precio ahora mismo cuando hay lecturas', () => {
  const r = byKey(read(SIDEWAYS, { now: { vote: -2, text: 'bajando con fuerza', net: -6 } }));
  assert.equal(r.momentum.text, 'bajando con fuerza');
  assert.equal(r.momentum.lean, 'down');
});

test('las lecturas cuentan en la decisión, pero menos que lo más reciente', () => {
  const side = { dir: null };
  const none = { vote: 0, text: 'sin fuerza' };
  const bear = { vote: -1, text: 'cuerpo fuerte rojo' };
  const strong = { vote: 2, text: '4 arriba, 0 abajo' };
  const mild = { vote: 1, text: '2 arriba, 1 abajo' };

  // Contexto fuerte solo: 2 votos -> señal. Contexto leve solo: no alcanza.
  let d = decide(side, none, [], { context: strong });
  assert.equal(d.dir, 'up');
  assert.match(d.reason, /lecturas: 4 arriba, 0 abajo/);
  assert.equal(decide(side, none, [], { context: mild }).dir, null);
  // Contexto leve + un tramo del precio a favor: sí
  assert.equal(decide(side, none, ['up'], { context: mild }).dir, 'up');
  // La vela actual en contra (2 votos) anula un contexto fuerte (2 votos)
  assert.equal(decide(side, bear, [], { context: strong }).dir, null);
  // Y con el precio bajando ahora mismo, gana lo reciente
  assert.equal(decide(side, bear, [], { context: strong, ticks: { vote: -2, text: 'bajando con fuerza', net: -6 } }).dir, 'down');
  // Simetría
  assert.equal(decide(side, none, [], { context: { vote: -2, text: '0 arriba, 4 abajo' } }).dir, 'down');
  // Un contexto exagerado no pasa de 2 votos
  assert.equal(decide(side, bear, [], { context: { vote: 9, text: 'x' } }).dir, null);
});

test('a la IA se le mandan las 8 lecturas en números', () => {
  const r = read(RISING, { asset: 'AED/CNY OTC' });
  const snapshot = describeChart(RISING, [], 5, { readings: r.data });
  assert.equal(snapshot.lecturas.velas_en_historial, 40);
  assert.equal(snapshot.lecturas.tendencia.direccion, 'up');
  assert.deepEqual(snapshot.lecturas.ema.periodos, [9, 21]);
  assert.equal(typeof snapshot.lecturas.rsi, 'number');
  assert.equal(snapshot.lecturas.sesion, 'OTC · 24 h');
  assert.ok('soporte_abajo' in snapshot.lecturas && 'resistencia_arriba' in snapshot.lecturas);
  assert.equal(describeChart(RISING, [], 5).lecturas, undefined);
});
