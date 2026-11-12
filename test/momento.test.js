/** Memoria por momento de la vela y reloj de la vela para las IA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMarketMemory, momentTable, momentSituation, segmentsOf, segmentCount } = require('../src/memory');
const { describeChart, systemPrompt } = require('../src/ai');
const { chain } = require('./helpers');

const PERIOD = 15000;
const candle = (dir) => ({ dir, open: 0, close: dir === 'up' ? 1 : -1, high: 2, low: -2 });
const visible = (colors) => [...colors].map((c) => candle(c === 'u' ? 'up' : 'down'));
/** Velas guardadas: [color, tramos], una cada 15 s. */
const records = (list, start = 1000000) => list.map(([d, s], i) => ({ t: start + i * PERIOD, d, b: 1, r: 2, s }));

test('en cuántos tramos se parte una vela', () => {
  assert.equal(segmentCount(15, 5), 3); // vela de 15 s, operación de 5 s
  assert.equal(segmentCount(15, 10), 2);
  assert.equal(segmentCount(15, 15), 1);
  assert.equal(segmentCount(60, 5), 6); // como mucho 6
  assert.equal(segmentCount(5, 15), 1);
  assert.equal(segmentCount(0, 5), 0); // aún no se sabe el tamaño de vela
});

test('tramos de una vela: hacia dónde fue el precio en cada uno', () => {
  // Precio cada 0.5 s durante 15 s: sube 5 s, baja 5 s, quieto 5 s
  const prices = [];
  for (let i = 0; i <= 30; i++) {
    const t = i * 500;
    const value = t <= 5000 ? 100 + t / 500 : t <= 10000 ? 110 - (t - 5000) / 250 : 90;
    prices.push({ time: 1000 + t, value });
  }
  assert.equal(segmentsOf(prices, 1000, 16000, 3), 'udf');
  assert.equal(segmentsOf(prices, 1000, 16000, 1), 'd'); // la vela entera: bajó
  // Si falta la lectura del precio en una parte, ese tramo queda sin saber
  assert.equal(segmentsOf(prices.filter((p) => p.time < 9000), 1000, 16000, 3), 'u??');
  assert.equal(segmentsOf([], 1000, 16000, 3), '');
});

test('tabla por momento: tras la racha anterior, qué hizo el precio en cada tramo', () => {
  // Patrón repetido: verde, verde, y en la vela que sigue el primer tramo siempre sube y el segundo baja
  const list = [];
  for (let i = 0; i < 20; i++) list.push(['u', 'uuu'], ['u', 'uuu'], ['d', 'udd']);
  const table = momentTable(records(list));
  // La tercera vela de cada grupo viene tras 2 verdes seguidas
  assert.deepEqual(table['u2:3:0'], { up: 20, down: 0 });
  assert.deepEqual(table['u2:3:1'], { up: 0, down: 20 });
  assert.deepEqual(table['u2:3:2'], { up: 0, down: 20 });
  // Las velas sin tramos guardados (las de antes de este cambio) no cuentan
  assert.deepEqual(momentTable(records([['u', ''], ['u', ''], ['d', '']])), {});
});

test('qué dice la memoria de este momento de la vela, y cuándo vota', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(['u', 'uuu'], ['u', 'uuu'], ['d', 'udd']);
  const table = momentTable(records(list));
  const clock = (elapsed, formingDir = 'down') => ({ elapsed, candleSeconds: 15, tradeSeconds: 5, formingDir });

  // Van 2 verdes y la vela acaba de empezar: en el tramo 1 el precio subió 20 de 20
  let m = momentSituation(table, visible('duu'), clock(0.5));
  assert.equal(m.vote, 2);
  assert.equal(m.text, 'tras 2 verdes seguidas, en el tramo 1 de 3 de la vela el precio subió 20 de 20 veces (100 %)');
  assert.equal(m.data.tramo, '1 de 3');
  // A los 6 s (tramo 2): bajó 20 de 20
  m = momentSituation(table, visible('duu'), clock(6));
  assert.equal(m.vote, -2);
  assert.match(m.text, /tramo 2 de 3 de la vela el precio bajó 20 de 20/);
  // A los 14 s la operación ya cae en la vela siguiente: la racha cuenta la vela en curso (va roja -> "1 roja")
  m = momentSituation(table, visible('duu'), clock(14, 'down'));
  assert.equal(m.data.racha_antes_de_la_vela, '1 roja');
  assert.equal(m.data.tramo, '1 de 3');
  // ...y si la vela en curso va verde, la racha sube a 3 verdes (situación sin casos)
  m = momentSituation(table, visible('duu'), clock(14, 'up'));
  assert.equal(m.data.racha_antes_de_la_vela, '3 verdes seguidas');
  assert.equal(m.cases, 0);
  assert.equal(m.vote, 0);

  // Pocos casos: informa pero no vota
  const few = momentTable(records([['u', 'uuu'], ['u', 'uuu'], ['d', 'udd'], ['u', 'uuu'], ['u', 'uuu'], ['d', 'udd']]));
  m = momentSituation(few, visible('duu'), clock(0.5));
  assert.equal(m.vote, 0);
  assert.match(m.text, /pocos casos aún/);
  // Sin reloj no se puede saber el momento
  assert.equal(momentSituation(table, visible('duu'), null), null);
  assert.equal(momentSituation(table, visible('duu'), { elapsed: null, candleSeconds: 15, tradeSeconds: 5 }), null);
});

test('los tramos se guardan en disco y la memoria los usa al predecir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momento-'));
  try {
    let memory = createMarketMemory(dir);
    memory.setAsset('EUR/USD OTC');
    const group = [['up', 'uuu'], ['up', 'uuu'], ['down', 'udd']];
    for (let i = 0; i < 60; i++) memory.add(candle(group[i % 3][0]), 5000000 + i * PERIOD, 4, group[i % 3][1]);
    memory.flush();
    const lines = fs.readFileSync(path.join(dir, 'eur-usd-otc_15s.csv'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 60);
    assert.match(lines[59], /,d,[\d.]+,[\d.]+,udd$/);

    // Al volver a abrir, la memoria por momento sigue ahí
    memory = createMarketMemory(dir);
    memory.setAsset('EUR/USD OTC');
    [...'uud'].forEach((c, i) => memory.add(candle(c === 'u' ? 'up' : 'down'), 99000000 + i * PERIOD, 4, c === 'd' ? 'udd' : 'uuu'));
    memory.add(candle('up'), 99000000 + 3 * PERIOD, 4, 'uuu');
    const s = memory.stats(visible('duu'), { elapsed: 6, tradeSeconds: 5, formingDir: 'down' });
    assert.equal(s.candleSeconds, 15);
    assert.equal(s.moment.vote, -2); // tramo 2 tras 2 verdes: bajó siempre
    assert.match(s.text, /^tras 2 verdes seguidas, en el tramo 2 de 3 de la vela el precio bajó/);
    assert.equal(s.data.por_momento_de_la_vela.tramo, '2 de 3');
    assert.ok(Math.abs(s.vote) <= 2); // el voto total nunca pasa de 2
    // Sin reloj, la memoria responde solo por vela completa, como antes
    assert.equal(memory.stats(visible('duu')).moment, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a las IA se les manda el reloj de la vela', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const snapshot = describeChart(candles, [], 5, { clock: { elapsed: 12.4, seconds: 15 } });
  assert.deepEqual(
    { lleva: snapshot.reloj_de_la_vela.lleva_segundos, dura: snapshot.reloj_de_la_vela.dura_segundos, faltan: snapshot.reloj_de_la_vela.le_faltan_segundos },
    { lleva: 12.4, dura: 15, faltan: 2.6 },
  );
  assert.equal(describeChart(candles, [], 5).reloj_de_la_vela, undefined);
  assert.equal(describeChart(candles, [], 5, { clock: { elapsed: 3, seconds: 0 } }).reloj_de_la_vela, undefined);
  assert.match(systemPrompt(true), /reloj_de_la_vela/);
  assert.match(systemPrompt(true), /por_momento_de_la_vela/);
});
