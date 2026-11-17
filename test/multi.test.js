// Varios pares a la vez (16 nov 2026): lectura de cada par, eleccion del mejor y la serie que brinca entre pares.
const test = require('node:test');
const assert = require('node:assert');
const { readPair, pickBest, createMultiEngine, MIN_CANDLES } = require('../src/multi');

/** Velas [o,h,l,c] que suben (o bajan) un paso cada una. */
function staircase(count, step, start = 100) {
  const out = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    out.push([open, Math.max(open, close) + Math.abs(step) * 0.2, Math.min(open, close) - Math.abs(step) * 0.2, close]);
    price = close;
  }
  return out;
}

test('un par que sube sin parar se lee hacia arriba; con pocas velas no se lee', () => {
  const candles = staircase(MIN_CANDLES + 20, 0.01);
  const read = readPair({ closed: candles.slice(0, -1), forming: candles[candles.length - 1], time: new Date(2026, 10, 16, 12), asset: 'EUR/USD OTC' });
  assert.ok(read && read.ups + read.downs > 0);
  assert.strictEqual(read.margin, Math.abs(read.ups - read.downs));
  assert.ok(['up', 'down', null].includes(read.dir));
  assert.strictEqual(readPair({ closed: candles.slice(0, 10), forming: candles[10], time: new Date() }), null);
});

test('se escoge el par con mas ventaja; los viejos, los que pagan poco y los tipos apagados no cuentan', () => {
  const r = (name, margin, extra = {}) => ({ name, payout: 92, age: 0.4, read: { dir: 'up', margin, ups: margin, downs: 0, pattern: 'rango' }, ...extra });
  assert.strictEqual(pickBest([r('A', 2), r('B', 4), r('C', 3)]).name, 'B');
  assert.strictEqual(pickBest([r('A', 2), r('B', 4, { age: 9 })]).name, 'A'); // B no tiene precio fresco
  assert.strictEqual(pickBest([r('A', 3, { payout: 60 }), r('B', 2)]).name, 'B'); // A paga poco
  assert.strictEqual(pickBest([r('A', 1), r('B', 1)]), null); // nadie llega a 2 de ventaja
  assert.strictEqual(pickBest([r('A', 4), r('B', 3, { read: { dir: 'down', margin: 3, pattern: 'rechazo' } })], { avoid: ['rango'] }).name, 'B');
  assert.strictEqual(pickBest([r('A', 3, { payout: 85 }), r('B', 3)]).name, 'B'); // misma ventaja: el que paga mas
});

test('la serie brinca de par: pierde en uno, la martingala sale donde este la mejor lectura, y el empate repite el monto', async () => {
  const up = staircase(MIN_CANDLES + 30, 0.01);
  const down = staircase(MIN_CANDLES + 30, -0.01);
  const flat = Array.from({ length: MIN_CANDLES + 30 }, () => [100, 100.001, 99.999, 100]);
  const books = { 'AAA OTC': up, 'BBB OTC': flat };
  const results = ['loss', 'tie', 'win'];
  const orders = [];
  const lines = [];
  let clock = 1000000;
  const bot = {
    candles: async (pairs) => ({ ok: true, seconds: 15, pairs: pairs.map((name) => [name.replace(/\W/g, ''), name, 92, books[name].slice(0, -1), books[name][books[name].length - 1], 0.3, 4]) }),
    order: async (payload) => {
      orders.push(payload);
      return { ok: true, id: `id${orders.length}`, open_price: 1, payout: 92, amount: [1, 2.2, 4.84][payload.level], open_ms: clock + 200, sent_ms: clock };
    },
    result: async () => {
      const result = results.shift();
      const stake = [1, 2.2, 4.84][orders[orders.length - 1].level];
      return { ok: true, result, net: result === 'win' ? stake * 0.92 : result === 'loss' ? -stake : 0, close_price: 1 };
    },
  };
  const engine = createMultiEngine({ bot, record: (l) => lines.push(l), settings: () => ({ on: true, pairs: Object.keys(books), seconds: 3, levels: 4, minMargin: 1, minPayout: 80, avoid: [], restMs: 5000 }), now: () => clock });
  const first = readPair({ closed: up.slice(0, -1), forming: up[up.length - 1], time: new Date(clock) });
  assert.ok(first.dir, 'la escalera tiene que dar un lado');
  await engine.tick(); // entra en AAA y pierde
  assert.strictEqual(orders[0].asset, 'AAA OTC');
  assert.strictEqual(orders[0].level, 0);
  assert.strictEqual(engine.view().level, 1);
  // ahora AAA queda plano y BBB toma la lectura: la martingala brinca a BBB
  books['AAA OTC'] = flat;
  books['BBB OTC'] = down;
  await engine.tick(); // empata: mismo nivel
  assert.strictEqual(orders[1].asset, 'BBB OTC');
  assert.strictEqual(orders[1].level, 1);
  assert.strictEqual(engine.view().level, 1);
  await engine.tick(); // gana la martingala 1
  assert.strictEqual(orders[2].level, 1);
  const view = engine.view();
  assert.strictEqual(view.level, 0);
  assert.deepStrictEqual([view.tally.wins, view.tally.losses, view.tally.ties, view.tally.series, view.tally.lost], [1, 1, 1, 1, 0]);
  assert.ok(Math.abs(view.tally.net - (-1 + 2.2 * 0.92)) < 1e-9);
  // recien cerrada la serie se analiza unos segundos antes de abrir otra
  await engine.tick();
  assert.strictEqual(orders.length, 3);
  clock += 6000;
  results.push('win');
  await engine.tick();
  assert.strictEqual(orders.length, 4);
  assert.strictEqual(orders[3].level, 0);
  assert.ok(lines.some((l) => /^Q,\d+,serie,ganada,/.test(l)) && lines.some((l) => /^Q,\d+,entrada,BBB OTC,/.test(l)));
});

test('apagado no pregunta nada al bot; si el bot falla, no se rompe y lo dice', async () => {
  let asked = 0;
  const bot = { candles: async () => { asked++; throw new Error('el bot no contestó a tiempo'); } };
  let on = false;
  const engine = createMultiEngine({ bot, record: () => {}, settings: () => ({ on, pairs: ['A'], seconds: 3, levels: 4 }) });
  await engine.tick();
  assert.strictEqual(asked, 0);
  on = true;
  await engine.tick();
  assert.strictEqual(asked, 1);
  assert.strictEqual(engine.view().note, 'el bot no contestó a tiempo');
});

test('despues de perder, la martingala sale en OTRO par aunque el que perdio tenga la mejor lectura', async () => {
  const strong = staircase(MIN_CANDLES + 30, 0.01);
  const flat = Array.from({ length: MIN_CANDLES + 30 }, () => [100, 100.001, 99.999, 100]);
  const books = { 'AAA OTC': strong, 'BBB OTC': strong, 'CCC OTC': flat };
  const payouts = { 'AAA OTC': 92, 'BBB OTC': 85, 'CCC OTC': 92 };
  const results = ['loss', 'loss', 'win'];
  const orders = [];
  let clock = 5000000;
  const bot = {
    candles: async (pairs) => ({ ok: true, seconds: 15, pairs: pairs.map((name) => [name, name, payouts[name], books[name].slice(0, -1), books[name][books[name].length - 1], 0.3, 4]) }),
    order: async (payload) => { orders.push(payload.asset); return { ok: true, id: 'x', open_price: 1, payout: 92, amount: 1, open_ms: clock, sent_ms: clock }; },
    result: async () => { const result = results.shift(); return { ok: true, result, net: result === 'win' ? 1 : -1, close_price: 1 }; },
  };
  const engine = createMultiEngine({ bot, record: () => {}, settings: () => ({ on: true, pairs: Object.keys(books), seconds: 3, levels: 4, minMargin: 1, minPayout: 80, avoid: [], restMs: 0 }), now: () => clock });
  await engine.tick(); // AAA y BBB leen igual: gana AAA porque paga mas; pierde
  await engine.tick(); // brinca a BBB (AAA acaba de perder); pierde
  assert.strictEqual(engine.view().lostIn, 'BBB OTC');
  await engine.tick(); // vuelve a AAA (el que acaba de perder ahora es BBB); gana
  assert.deepStrictEqual(orders, ['AAA OTC', 'BBB OTC', 'AAA OTC']);
  assert.strictEqual(engine.view().lostIn, null);
});
