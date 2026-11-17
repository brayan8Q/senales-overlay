// Los pares se cambian solos cuando dejan de pagar el minimo (16 nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const { reviewPairs } = require('../src/autopairs');

const offers = [
  { name: 'USD/BRL OTC', payout: 80 },
  { name: 'EUR/USD OTC', payout: 92 },
  { name: 'AUD/CAD OTC', payout: 92 },
  { name: 'YER/USD OTC', payout: 92 },
  { name: 'CHF/JPY OTC', payout: 92 },
  { name: 'USD/EGP OTC', payout: 86 },
];

test('un par que paga poco se cambia solo despues de 20 s, por el mejor pagado que no este en uso', () => {
  const slots = ['USD/BRL OTC', 'EUR/USD OTC', 'CHF/JPY OTC', 'USD/EGP OTC'];
  let out = reviewPairs({ slots, offers, minPayout: 90, low: [0, 0, 0, 0], now: 1000 });
  assert.deepStrictEqual(out.slots, slots); // todavia no: puede ser un bajon de segundos
  assert.deepStrictEqual(out.low, [1000, 0, 0, 1000]);
  out = reviewPairs({ slots: out.slots, offers, minPayout: 90, low: out.low, now: 22000 });
  // entre los que pagan 92 y no estan en uso: primero el conocido (AUD/CAD), despues el raro (YER/USD)
  assert.deepStrictEqual(out.slots, ['AUD/CAD OTC', 'EUR/USD OTC', 'CHF/JPY OTC', 'YER/USD OTC']);
  assert.deepStrictEqual(out.changes.map((c) => [c.index, c.from, c.to, c.was, c.pays]), [[0, 'USD/BRL OTC', 'AUD/CAD OTC', 80, 92], [3, 'USD/EGP OTC', 'YER/USD OTC', 86, 92]]);
});

test('si el par se recupera antes de los 20 s no se cambia; un lugar vacio se respeta; sin reemplazo se queda', () => {
  const slots = ['USD/BRL OTC', '', 'EUR/USD OTC', 'CHF/JPY OTC'];
  let out = reviewPairs({ slots, offers, minPayout: 90, low: [0, 0, 0, 0], now: 1000 });
  const better = offers.map((o) => (o.name === 'USD/BRL OTC' ? { ...o, payout: 92 } : o));
  out = reviewPairs({ slots: out.slots, offers: better, minPayout: 90, low: out.low, now: 15000 });
  assert.deepStrictEqual(out.slots, slots);
  assert.deepStrictEqual(out.low, [0, 0, 0, 0]);
  const few = [{ name: 'USD/BRL OTC', payout: 80 }, { name: 'EUR/USD OTC', payout: 92 }];
  out = reviewPairs({ slots: ['USD/BRL OTC', 'EUR/USD OTC', '', ''], offers: few, minPayout: 90, low: [1, 0, 0, 0], now: 60000 });
  assert.deepStrictEqual(out.slots, ['USD/BRL OTC', 'EUR/USD OTC', '', '']);
  assert.strictEqual(out.changes.length, 0);
});

test('un par que el bot ya no tiene tambien se cambia', () => {
  const out = reviewPairs({ slots: ['XXX/YYY OTC', 'EUR/USD OTC', '', ''], offers, minPayout: 90, low: [1, 0, 0, 0], now: 30000 });
  assert.strictEqual(out.slots[0], 'AUD/CAD OTC');
  assert.strictEqual(out.changes[0].was, null);
});
