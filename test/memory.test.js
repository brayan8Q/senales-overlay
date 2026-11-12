/** Memoria del mercado: qué pasó otras veces tras una racha de velas como la de ahora. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMarketMemory, streakTable, situation, currentStreak, periodOf, periodBucket, slug } = require('../src/memory');
const { decide } = require('../src/timed');
const { describeChart, systemPrompt } = require('../src/ai');
const { chain } = require('./helpers');

const PERIOD = 15000;
/** Velas guardadas a partir de una cadena de colores: "uuud" = 3 verdes y 1 roja. */
const records = (colors, start = 1000000, period = PERIOD) => [...colors].map((d, i) => ({ t: start + i * period, d, b: 1, r: 2 }));
const candle = (dir) => ({ dir, open: 0, close: dir === 'up' ? 1 : -1, high: 2, low: -2 });
const visible = (colors) => [...colors].map((c) => candle(c === 'u' ? 'up' : c === 'd' ? 'down' : 'flat'));

test('tabla de rachas: tras 3 verdes siempre vino una roja', () => {
  // El ejemplo del usuario: 3 al alza y luego 1 a la baja, repetido
  const table = streakTable(records('uuud'.repeat(20)));
  assert.deepEqual(table.u3, { continued: 0, reversed: 20 });
  assert.deepEqual(table.u1, { continued: 20, reversed: 0 });
  assert.deepEqual(table.u2, { continued: 20, reversed: 0 });
  assert.deepEqual(table.d1, { continued: 0, reversed: 19 }); // la última roja no tiene siguiente
  assert.equal(table.u4, undefined);
});

test('qué dice la memoria de la situación actual, y cuándo vota', () => {
  const table = streakTable(records('uuud'.repeat(20)));
  // Ahora van 3 verdes seguidas -> la siguiente fue roja 20 de 20: vota abajo, con fuerza
  const s = situation(table, visible('duuu'), 80);
  assert.equal(s.cases, 20);
  assert.equal(s.vote, -2);
  assert.equal(s.text, 'tras 3 verdes seguidas, la siguiente fue roja 20 de 20 veces (100 %)');
  assert.equal(s.data.situacion_actual, '3 verdes seguidas');
  assert.equal(s.data.la_siguiente_giro, 20);
  assert.ok(s.data.tabla.some((row) => row.racha === '3 verdes seguidas' && row.la_siguiente_giro === 20));

  // Van 2 verdes -> la siguiente fue verde 20 de 20: vota arriba
  assert.equal(situation(table, visible('duu'), 80).vote, 2);
  // Va 1 roja -> la siguiente fue verde 19 de 19: vota arriba
  const afterRed = situation(table, visible('uuud'), 80);
  assert.equal(afterRed.vote, 2);
  assert.match(afterRed.text, /^tras 1 roja, la siguiente fue verde 19 de 19/);
});

test('con pocos casos, o mitad y mitad, informa pero no vota', () => {
  // Solo 5 casos de "3 verdes seguidas"
  const few = situation(streakTable(records('uuud'.repeat(5))), visible('uuu'), 20);
  assert.equal(few.cases, 5);
  assert.equal(few.vote, 0);
  assert.match(few.text, /pocos casos aún/);

  // Muchos casos pero sin ventaja: tras una verde, la mitad de las veces sigue y la mitad gira
  const even = situation(streakTable(records('uudud'.repeat(30))), visible('ddu'), 150);
  assert.ok(even.cases >= 50);
  assert.equal(even.vote, 0);
  assert.match(even.text, /sin ventaja clara/);

  // Situación nunca vista
  const never = situation(streakTable(records('ud'.repeat(30))), visible('uuu'), 60);
  assert.equal(never.cases, 0);
  assert.match(never.text, /aún sin casos iguales/);
  // Sin memoria todavía
  assert.equal(situation({}, visible('uu'), 0).vote, 0);
});

test('no se cruzan los huecos: si el panel no estuvo mirando, la racha se corta', () => {
  // Dos sesiones separadas por una hora: "uu" | "ud"
  const list = [...records('uu'), ...records('ud', 1000000 + 3600000)];
  const table = streakTable(list, PERIOD);
  // Dentro de cada sesión: u1 -> siguió (1ª sesión), u1 -> giró (2ª). La 2ª "u" de la 1ª sesión NO se une a la 2ª sesión.
  assert.deepEqual(table.u1, { continued: 1, reversed: 1 });
  assert.equal(table.u2, undefined);
  assert.equal(table.u3, undefined);
});

test('racha actual y tamaño de vela', () => {
  assert.deepEqual(currentStreak(visible('duuu')), { dir: 'u', length: 3 });
  assert.deepEqual(currentStreak(visible('uud')), { dir: 'd', length: 1 });
  assert.deepEqual(currentStreak(visible('uuf')), { dir: 'f', length: 0 });
  assert.deepEqual(currentStreak([]), { dir: 'f', length: 0 });
  assert.equal(periodBucket(periodOf(records('uuuu', 0, 15200))), 15);
  assert.equal(periodBucket(periodOf(records('uuuu', 0, 29500))), 30);
  assert.equal(periodBucket(periodOf(records('uuuu', 0, 61000))), 60);
  assert.equal(periodOf(records('uu')), 0); // con dos velas aún no se sabe
  assert.equal(slug('EUR/USD OTC'), 'eur-usd-otc');
  assert.equal(slug(''), 'sin-nombre');
});

test('se guarda en disco por activo y se recuerda al volver a abrir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-'));
  try {
    let memory = createMarketMemory(dir);
    memory.setAsset('EUR/USD OTC');
    const colors = 'uuud'.repeat(15);
    [...colors].forEach((c, i) => memory.add(candle(c === 'u' ? 'up' : 'down'), 5000000 + i * PERIOD, 4));
    assert.equal(memory.count(), 60);
    let s = memory.stats(visible('duuu'));
    assert.equal(s.candleSeconds, 15);
    assert.equal(s.vote, -2);
    assert.equal(s.total, 60);
    memory.flush();
    assert.ok(fs.existsSync(path.join(dir, 'eur-usd-otc_15s.csv')));

    // Otro día: se abre de nuevo el mismo activo y, tras ver unas velas, la memoria anterior vuelve
    memory = createMarketMemory(dir);
    memory.setAsset('EUR/USD OTC');
    assert.equal(memory.stats(visible('uuu')).cases, 0); // aún no sabe el tamaño de vela: no ha cargado nada
    [...'uuud'].forEach((c, i) => memory.add(candle(c === 'u' ? 'up' : 'down'), 99000000 + i * PERIOD, 4));
    assert.equal(memory.count(), 64);
    s = memory.stats(visible('duuu'));
    assert.equal(s.cases, 16);
    assert.equal(s.vote, -2);

    // Otro activo: memoria aparte, vacía
    memory.setAsset('GBP/USD OTC');
    assert.equal(memory.count(), 0);
    [...'udud'].forEach((c, i) => memory.add(candle(c === 'u' ? 'up' : 'down'), 99900000 + i * PERIOD, 4));
    memory.flush();
    assert.ok(fs.existsSync(path.join(dir, 'gbp-usd-otc_15s.csv')));
    assert.equal(fs.readFileSync(path.join(dir, 'eur-usd-otc_15s.csv'), 'utf8').trim().split('\n').length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('la memoria cuenta en la señal y se le manda a las IA', () => {
  const side = { dir: null };
  const none = { vote: 0, text: 'sin fuerza' };
  const memory = { vote: -2, text: 'tras 3 verdes seguidas, la siguiente fue roja 18 de 22 veces (82 %)' };
  // Sola alcanza para dar señal (2 votos)
  const d = decide(side, none, [], { memory });
  assert.equal(d.dir, 'down');
  assert.match(d.reason, /^Memoria: tras 3 verdes seguidas, la siguiente fue roja 18 de 22/);
  // Sin voto no aparece ni cuenta
  assert.equal(decide(side, none, [], { memory: { vote: 0, text: 'pocos casos' } }).dir, null);
  // No pasa de 2 votos: lo que el precio hace ahora mismo puede contrarrestarla
  assert.equal(decide(side, none, [], { memory: { vote: -9, text: 'x' }, ticks: { vote: 2, text: 'subiendo con fuerza', net: 6 } }).dir, null);
  // También cuenta cuando hay un patrón medido
  assert.equal(decide(side, none, [], { memory, regime: { kind: 'continua', vote: 0, text: 'continúa 60 %' } }).dir, 'down');

  const table = streakTable(records('uuud'.repeat(20)));
  const info = situation(table, visible('duuu'), 80);
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const snapshot = describeChart(candles, [], 5, { memory: info.data });
  assert.equal(snapshot.memoria_del_mercado.situacion_actual, '3 verdes seguidas');
  assert.equal(snapshot.memoria_del_mercado.casos_iguales_antes, 20);
  assert.equal(describeChart(candles, [], 5).memoria_del_mercado, undefined);
  assert.match(systemPrompt(true), /memoria_del_mercado/);
});
