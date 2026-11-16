const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, MARTIN_SYNC_MIN_MS, CLOCK_WAIT_MS } = require('../src/timed');
const { candleSeen, candleChange, askMoment } = require('../src/lastcandle');
const { chain } = require('./helpers');

// LA ÚLTIMA VELA (15 nov 2026, tarde): a la IA se le pregunta tarde (ve la vela casi completa), la
// señal se confirma con la vela ya cerrada, y la martingala analizada también sale al abrir vela.
const row = (price) => -price;
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // las reglas dan ARRIBA
const PERIOD = 15000;
const clock = (now) => ({ known: true, seconds: 15, elapsedMs: now % PERIOD, remainingMs: PERIOD - (now % PERIOD), closedNow: now % PERIOD === 0, closeRow: null });
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
const IA_UP = { dir: 'up', confidence: 'alta', reason: 'IA: vela verde fuerte' };
const IA_DOWN = { dir: 'down', confidence: 'alta', reason: 'IA: giro bajista' };

// ---------- Cuándo se pregunta ----------
test('pregunta tarde: con la señal al abrir la vela, se pregunta cuando le faltan 3 s (no al empezar el análisis)', () => {
  const lead = 3000;
  // Empieza el análisis: a la vela le faltan 5.5 s. Todavía no.
  assert.deepEqual(askMoment({ phase: 'analysis', remainingMs: 5000, clockLeftMs: 5500, leadMs: lead }), { untilSignal: 5500, tooEarly: true });
  assert.equal(askMoment({ phase: 'analysis', remainingMs: 2600, clockLeftMs: 3100, leadMs: lead }).tooEarly, true);
  // Le faltan 3 s: ahora. La IA tiene hasta que abra la vela.
  assert.deepEqual(askMoment({ phase: 'analysis', remainingMs: 2500, clockLeftMs: 3000, leadMs: lead }), { untilSignal: 3000, tooEarly: false });
});

test('pregunta tarde: sin reloj, o con un análisis que no termina con la vela, se pregunta al empezar como antes', () => {
  assert.deepEqual(askMoment({ phase: 'analysis', remainingMs: 5000, clockLeftMs: null, leadMs: 3000 }), { untilSignal: null, tooEarly: false });
  // El análisis (5 s) terminará mucho antes de que cierre la vela (le faltan 12 s): no está sincronizado.
  assert.deepEqual(askMoment({ phase: 'analysis', remainingMs: 5000, clockLeftMs: 12000, leadMs: 3000 }), { untilSignal: null, tooEarly: false });
  assert.deepEqual(askMoment({ phase: 'signal', remainingMs: 2000, clockLeftMs: 2000, leadMs: 3000 }), { untilSignal: null, tooEarly: false });
});

test('pregunta tarde: la martingala en análisis pregunta cuando faltan 3 s para que salga', () => {
  assert.equal(askMoment({ phase: 'analysis', thinking: 1, remainingMs: 12000, clockLeftMs: 12000, leadMs: 3000 }).tooEarly, true);
  assert.deepEqual(askMoment({ phase: 'analysis', thinking: 1, remainingMs: 2900, clockLeftMs: 2900, leadMs: 3000 }), { untilSignal: 2900, tooEarly: false });
  // Martingala que espera la vela que sigue a la siguiente: el reloj dice 1 s, pero faltan 16.
  assert.equal(askMoment({ phase: 'analysis', thinking: 2, remainingMs: 16000, clockLeftMs: 1000, leadMs: 3000 }).tooEarly, true);
  // Martingala sin reloj (2.5 s de análisis): se pregunta al momento.
  assert.deepEqual(askMoment({ phase: 'analysis', thinking: 1, remainingMs: 2500, clockLeftMs: null, leadMs: 3000 }), { untilSignal: 2500, tooEarly: false });
});

// ---------- La vela que vio la IA y cómo quedó ----------
const feedCandles = (dirs, firstTime = 100) => dirs.map((dir, i) => ({ dir, time: firstTime + i * 15 }));

test('confirmación: con la fuente interna la vela se reconoce por su hora, en curso o ya cerrada', () => {
  const asked = feedCandles(['down', 'up', 'up']); // la vela en curso (hora 130) iba verde
  const seen = candleSeen(asked, { known: true, seconds: 15, startedAt: 130000 }, 142000);
  assert.deepEqual(seen, { time: 130, startedAt: 130000, periodMs: 15000, dir: 'up' });
  // Sigue en curso y sigue verde.
  assert.deepEqual(candleChange(seen, feedCandles(['down', 'up', 'up']), null, 143000), { changed: false, was: 'up', now: 'up', closed: false });
  // Sigue en curso pero ya se puso roja.
  assert.deepEqual(candleChange(seen, feedCandles(['down', 'up', 'down']), null, 144500), { changed: true, was: 'up', now: 'down', closed: false });
  // Ya cerró (roja) y abrió la siguiente.
  assert.deepEqual(candleChange(seen, feedCandles(['down', 'up', 'down', 'up']), null, 145300), { changed: true, was: 'up', now: 'down', closed: true });
  // Cerró verde: no cambió.
  assert.equal(candleChange(seen, feedCandles(['down', 'up', 'up', 'down']), null, 145300).changed, false);
  // Pasaron dos velas: esa consulta ya es vieja, no se comprueba nada.
  assert.equal(candleChange(seen, feedCandles(['down', 'up', 'down', 'up', 'up']), null, 161000), null);
});

test('confirmación: por píxeles (sin hora en las velas) la vela se ubica con el reloj', () => {
  const plain = (dirs) => dirs.map((dir) => ({ dir }));
  const seen = candleSeen(plain(['down', 'up', 'down']), { known: true, seconds: 15, elapsedMs: 12000 }, 12000);
  assert.deepEqual(seen, { time: null, startedAt: 0, periodMs: 15000, dir: 'down' });
  // Misma vela, todavía en curso.
  assert.deepEqual(candleChange(seen, plain(['down', 'up', 'up']), { known: true, seconds: 15, elapsedMs: 14000 }, 14000), { changed: true, was: 'down', now: 'up', closed: false });
  // Abrió la siguiente (el reloj va 0.4 s dentro): la vela consultada es la anterior.
  assert.deepEqual(candleChange(seen, plain(['down', 'up', 'down', 'up']), { known: true, seconds: 15, elapsedMs: 400 }, 15400), { changed: false, was: 'down', now: 'down', closed: true });
  // Dos velas después, reloj desconocido o desfasado: no se comprueba.
  assert.equal(candleChange(seen, plain(['down', 'up', 'down', 'up', 'up']), { known: true, seconds: 15, elapsedMs: 400 }, 30400), null);
  assert.equal(candleChange(seen, plain(['down', 'up', 'down', 'up']), { known: false }, 15400), null);
  assert.equal(candleChange(seen, plain(['down', 'up', 'down', 'up']), { known: true, seconds: 15, elapsedMs: 7000 }, 15400), null);
});

test('confirmación: una vela sin cuerpo no cuenta como cambio de color; sin consulta no hay nada que comprobar', () => {
  const seen = candleSeen(feedCandles(['up', 'flat']), null, 0);
  assert.equal(candleChange(seen, feedCandles(['up', 'down']), null, 1000).changed, false);
  const green = candleSeen(feedCandles(['up', 'up']), null, 0);
  assert.equal(candleChange(green, feedCandles(['up', 'flat']), null, 1000).changed, false);
  assert.equal(candleChange(null, feedCandles(['up', 'down']), null, 1000), null);
  assert.equal(candleSeen([], null, 0), null);
});

// ---------- La señal se confirma con la vela cerrada ----------
const manualRead = () => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now, extra = {}) => t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, ...extra });
  return { t, read };
};
const FLIPPED = { changed: true, was: 'up', now: 'down', closed: true };
const SAME = { changed: false, was: 'up', now: 'up', closed: true };

test('si la última vela cambió de color después de que la IA la miró, la señal no entra y se mide en papel', () => {
  const { read } = manualRead();
  let s = read(112, 0, { advice: IA_UP, lastCandle: FLIPPED });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, null); // ESPERAR
  assert.equal(s.signal.source, 'ia');
  assert.equal(s.signal.veto.kind, 'vela');
  assert.equal(s.signal.veto.dir, 'up');
  assert.deepEqual(s.signal.veto.data, { was: 'up', now: 'down' });
  assert.equal(s.signal.reason, 'La última vela cambió de color después de que la IA la miró (iba verde y cerró roja): su lectura ya no vale. La señal era ARRIBA.');
  assert.equal(s.follow, null);
  // En papel: al plazo se sabe qué habría pasado. No cuenta en el marcador.
  s = read(114, 3000);
  assert.deepEqual(s.vetoResults.map((v) => [v.kind, v.dir, v.result]), [['vela', 'up', 'acertó']]);
  assert.deepEqual(tally(s), [0, 0, 0]);
});

test('si la vela quedó del mismo color (o no se pudo comprobar), la señal de la IA sale como siempre', () => {
  let { read } = manualRead();
  let s = read(112, 0, { advice: IA_UP, lastCandle: SAME });
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.signal.veto, null);
  ({ read } = manualRead());
  s = read(112, 0, { advice: IA_UP, lastCandle: null });
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.signal.veto, null);
});

test('la confirmación es sobre lo que dijo la IA: una señal de las reglas (que ya ven la vela cerrada) no se frena', () => {
  const { read } = manualRead();
  const s = read(112, 0, { lastCandle: FLIPPED });
  assert.equal(s.signal.source, 'reglas');
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.signal.veto, null);
});

// ---------- La martingala analizada sale al abrir vela ----------
const auto = ({ cycleMs = 3000, martin = 2 } = {}) => {
  const t = createTimedTracker();
  const read = (now, price, extra = {}) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs, pauseMs: 5000, payout: 92, manual: false, newCandle: true, martin, martinThinkMs: 2500, candle: clock(now), ...extra });
  // Señal ARRIBA al abrir la segunda vela (15.0 s), en 112.
  read(PERIOD - 5500, 112);
  read(14500, 112);
  const first = read(15000, 112);
  assert.equal(first.phase, 'signal');
  assert.equal(first.signal.dir, 'up');
  return { t, read };
};

test('la martingala analizada ya no sale a media vela: espera a que abra la vela siguiente', () => {
  const { t, read } = auto();
  let s = read(18000, 110); // perdió a los 3 s de la vela
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.phase, 'analysis'); // sigue escaneando, sin entrar
  assert.equal(s.signal, null);
  assert.equal(s.thinking, 1);
  assert.equal(s.remainingMs, 12000); // lo que falta para que abra la vela nueva
  assert.equal(s.ready, false);
  assert.equal(t.predict(), false);
  // La IA ya contestó, pero la martingala no se adelanta: sale al abrir la vela.
  s = read(27500, 110, { advice: IA_DOWN });
  assert.equal(s.phase, 'analysis');
  assert.equal(s.remainingMs, 2500);
  s = read(29900, 110, { advice: IA_DOWN });
  assert.equal(s.phase, 'analysis');
  s = read(30000, 110, { advice: IA_DOWN }); // abre la vela
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.martin, 1);
  assert.equal(s.signal.dir, 'down');
  assert.equal(s.signal.reason, 'Martingala 1: la señal ARRIBA perdió. Nuevo análisis de la IA: IA: giro bajista');
  assert.equal(s.thinking, 0);
  // Si también pierde, la segunda martingala espera a la vela que sigue.
  s = read(33000, 112);
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.thinking, 2);
  assert.equal(s.remainingMs, 12000);
  s = read(45100, 112);
  assert.equal(s.signal.martin, 2);
});

test('si la IA no contesta, al abrir la vela la martingala la deciden las reglas', () => {
  const { read } = auto();
  read(18000, 110);
  const s = read(30050, 110);
  assert.equal(s.signal.source, 'martingala');
  assert.match(s.signal.reason, /^Martingala 1: la señal ARRIBA perdió\. Nuevo análisis: /);
});

test('si la señal pierde con la vela a punto de cerrar, la martingala sale en la vela que le sigue (da tiempo de analizar)', () => {
  const { read } = auto({ cycleMs: 14000 });
  let s = read(29000, 110); // perdió cuando a la vela le faltaba 1 s
  assert.equal(s.lastResult, 'falló');
  assert.ok(1000 < MARTIN_SYNC_MIN_MS);
  assert.equal(s.thinking, 1);
  assert.equal(s.remainingMs, 16000);
  s = read(30100, 110);
  assert.equal(s.phase, 'analysis'); // esta vela se deja pasar
  s = read(44900, 110);
  assert.equal(s.phase, 'analysis');
  s = read(45000, 110);
  assert.equal(s.signal.source, 'martingala');
});

test('martingala: si la vela cambió de color después de que la IA la miró, no se cancela: deciden las reglas', () => {
  const { read } = auto();
  read(18000, 110);
  const s = read(30000, 110, { advice: IA_DOWN, lastCandle: { changed: true, was: 'down', now: 'up', closed: true } });
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.martin, 1);
  assert.match(s.signal.reason, /^Martingala 1: la señal ARRIBA perdió\. Nuevo análisis \(la última vela cambió de color después de que la IA la miró: deciden las reglas\): /);
  assert.doesNotMatch(s.signal.reason, /IA: giro bajista/);
});

test('sin reloj de la vela la martingala analizada sigue como antes: se analiza 2.5 s y entra', () => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now, extra = {}) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, newCandle: true, martin: 1, martinThinkMs: 2500, candle: { known: false }, ...extra });
  read(112, 0);
  let s = read(110, 3000);
  assert.equal(s.thinking, 1);
  assert.equal(s.remainingMs, 2500);
  s = read(110, 5500);
  assert.equal(s.signal.source, 'martingala');
});

// ---------- Sin reloj de la vela no se predice ----------
test('sin reloj exacto no sale señal a media vela: se espera a tenerlo y sale al abrir la vela', () => {
  const t = createTimedTracker();
  let known = false;
  const read = (now, price = 112) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, waitClock: true, candle: known ? clock(now) : { known: false } });
  let s = read(1000);
  assert.equal(s.phase, 'waiting'); // antes: analizaba ya y predecía a los 6 s, a media vela
  s = read(8000);
  assert.equal(s.phase, 'waiting');
  assert.equal(s.signal, null);
  known = true; // vuelve el reloj
  s = read(PERIOD + 9600);
  assert.equal(s.phase, 'analysis');
  read(2 * PERIOD - 300);
  s = read(2 * PERIOD + 200);
  assert.equal(s.phase, 'signal');
});

test('sin reloj exacto la martingala no sale a media vela: espera el reloj y entra al abrir la vela; si no vuelve, se suelta', () => {
  const run = () => {
    const t = createTimedTracker();
    const state = { known: true };
    const read = (now, price) =>
      t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, waitClock: true, martin: 1, martinThinkMs: 2500, candle: state.known ? clock(now) : { known: false } });
    read(PERIOD - 5500, 112);
    read(14500, 112);
    read(15000, 112);
    state.known = false; // se pierde el reloj con la operación abierta
    const lost = read(18000, 110);
    assert.equal(lost.lastResult, 'falló');
    assert.equal(lost.thinking, 1);
    assert.equal(lost.signal, null);
    return { read, state };
  };
  let { read, state } = run();
  let s = read(22000, 110);
  assert.equal(s.signal, null); // nada a media vela
  state.known = true;
  s = read(24000, 110);
  assert.equal(s.thinking, 1);
  assert.equal(s.remainingMs, 6000);
  s = read(30000, 110);
  assert.equal(s.signal.source, 'martingala');

  ({ read, state } = run());
  s = read(18000 + CLOCK_WAIT_MS, 110);
  assert.equal(s.signal, null);
  assert.equal(s.thinking, 0);
  assert.match(s.lastResult, /^martingala suelta/);
});

// ---------- Con el bot la orden sale un instante antes de abrir la vela ----------
test('con el bot: la señal sale 150 ms antes de que abra la vela (para que la operación abra justo al empezar)', () => {
  const t = createTimedTracker();
  const read = (now) => t.update({ candles: UP, priceY: row(112), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, openLeadMs: 150, candle: clock(now) });
  read(PERIOD - 5500);
  let s = read(14500);
  assert.equal(s.phase, 'waiting');
  s = read(14800); // faltan 200 ms: todavía no
  assert.equal(s.phase, 'waiting');
  s = read(14860); // faltan 140 ms: sale
  assert.equal(s.phase, 'signal');
  // Y no se repite en la misma vela: la siguiente espera su ventana.
  s = read(18000);
  assert.notEqual(s.phase, 'signal');
});

test('con el bot: la martingala también sale 150 ms antes de la apertura', () => {
  const { read } = auto();
  read(18000, 110);
  const extra = { openLeadMs: 150 };
  let s = read(29800, 110, extra);
  assert.equal(s.phase, 'analysis');
  s = read(29860, 110, extra);
  assert.equal(s.signal.source, 'martingala');
});

// ---------- Dos segundos antes del cierre, y un segundo dentro de la vela nueva ----------
test('dos segundos antes: el análisis arranca cuando a la vela le faltan 2 s, sigue 1 s en la vela nueva y ahí sale la señal', () => {
  const t = createTimedTracker();
  const read = (now, extra = {}) =>
    t.update({ candles: UP, priceY: row(112), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, waitClock: true, syncBeforeMs: 2000, syncAfterMs: 1000, candle: clock(now), ...extra });
  let s = read(9500); // faltan 5.5 s: antes empezaba aquí; ya no
  assert.equal(s.phase, 'waiting');
  s = read(12900);
  assert.equal(s.phase, 'waiting');
  s = read(13000); // faltan 2 s: arranca
  assert.equal(s.phase, 'analysis');
  assert.equal(s.remainingMs, 3000);
  s = read(15000, { advice: IA_UP }); // abre la vela nueva: se sigue leyendo aunque la IA ya contestó
  assert.equal(s.phase, 'analysis');
  s = read(15900, { advice: IA_UP });
  assert.equal(s.phase, 'analysis');
  s = read(16000, { advice: IA_UP }); // 1 s dentro de la vela nueva: sale la señal
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.source, 'ia');
  assert.equal(s.signal.dir, 'up');
  // Una por vela: la siguiente vuelve a arrancar 2 s antes del cierre.
  s = read(19000);
  assert.notEqual(s.phase, 'signal');
  s = read(27900);
  assert.equal(s.phase, 'waiting');
  s = read(28000);
  assert.equal(s.phase, 'analysis');
});

test('dos segundos antes: la martingala también sale 1 s dentro de la vela nueva', () => {
  const t = createTimedTracker();
  const read = (now, price, extra = {}) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, pauseMs: 5000, payout: 92, manual: false, newCandle: true, martin: 1, martinThinkMs: 2500, syncBeforeMs: 2000, syncAfterMs: 1000, candle: clock(now), ...extra });
  read(13000, 112);
  let s = read(16000, 112);
  assert.equal(s.phase, 'signal');
  s = read(19000, 110); // perdió
  assert.equal(s.thinking, 1);
  assert.equal(s.remainingMs, 12000); // hasta 1 s dentro de la vela siguiente
  s = read(30500, 110);
  assert.equal(s.phase, 'analysis');
  s = read(31000, 110);
  assert.equal(s.signal.source, 'martingala');
});
