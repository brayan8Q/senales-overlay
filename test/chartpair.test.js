const test = require('node:test');
const assert = require('node:assert');
const { pairTolerance, pickChartPair } = require('../src/chartpair');

const ROWS = [
  ['AUDCAD_otc', 'AUD/CAD OTC', 1.05103, 0.3, 92],
  ['EURUSD_otc', 'EUR/USD OTC', 1.12071, 0.2, 92],
  ['AEDCNY_otc', 'AED/CNY OTC', 1.92006, 0.4, 92],
  ['USDJPY_otc', 'USD/JPY OTC', 151.234, 0.1, 80],
];
const ask = (extra) => pickChartPair({ rows: ROWS, quote: { value: 1.12072, pip: 0.0001 }, current: 'AUD/CAD OTC', tried: new Map(), now: 1000000, stuck: false, ...extra });

test('la tolerancia es de 3 pips y crece con el precio', () => {
  assert.ok(Math.abs(pairTolerance(1.12, 0.0001) - 0.0003) < 1e-9);
  assert.ok(pairTolerance(151.2, 0.01) > 0.03);
});

test('elige el par que va al precio de la pantalla', () => {
  const found = ask();
  assert.strictEqual(found.pick[0], 'EURUSD_otc');
  assert.strictEqual(found.same, false);
});

test('si lo escrito en Activo ya va a ese precio, no cambia', () => {
  const found = ask({ current: 'EUR/USD OTC' });
  assert.strictEqual(found.pick, null);
  assert.strictEqual(found.same, true);
  assert.strictEqual(ask({ current: 'EURUSD_otc' }).pick, null);
});

test('ningún par a ese precio: no elige nada', () => {
  const found = ask({ quote: { value: 0.75, pip: 0.0001 } });
  assert.strictEqual(found.pick, null);
  assert.strictEqual(found.same, false);
});

test('no usa precios viejos ni vuelve en un minuto a un par ya probado', () => {
  const old = ROWS.map((r) => (r[0] === 'EURUSD_otc' ? [r[0], r[1], r[2], 9, r[4]] : r));
  assert.strictEqual(ask({ rows: old }).pick, null);
  assert.strictEqual(ask({ tried: new Map([['EURUSD_otc', 1000000 - 30000]]) }).pick, null);
  assert.strictEqual(ask({ tried: new Map([['EURUSD_otc', 1000000 - 90000]]) }).pick[0], 'EURUSD_otc');
});

test('dos pares al mismo precio: se queda con el escrito, y si lleva rato sin cuadrar prueba el otro', () => {
  const rows = [...ROWS, ['EURGBP_otc', 'EUR/GBP OTC', 1.12074, 0.2, 90]];
  assert.strictEqual(ask({ rows, current: 'EUR/USD OTC' }).pick, null);
  assert.strictEqual(ask({ rows, current: 'EUR/USD OTC', stuck: true }).pick[0], 'EURGBP_otc');
});
