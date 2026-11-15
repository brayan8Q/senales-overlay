const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, ENTRY_SEEN_LAG_MS: LAG, EXTERNAL_WAIT_MS } = require('../src/timed');
const { chain } = require('./helpers');

// DOS ETAPAS: 1) sale la señal y se espera a que el usuario ponga su operación; 2) desde que entra
// se cuenta el plazo, contra el precio de SU entrada. La martingala pasa por las mismas dos etapas.
const row = (price) => -price;
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // las reglas dan ARRIBA; la vela en curso cierra en 112
const FLAT = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1]); // sin lado: ESPERAR
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
const make = ({ martin = 0, wait = 5000, candles = UP } = {}) => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now, userEntered = false) =>
    t.update({ candles, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, martin, entryWaitMs: wait, userEntered });
  return { t, read };
};

test('etapa 1: sale la señal y se espera la entrada; el plazo todavía no cuenta', () => {
  const { t, read } = make();
  let s = read(112, 0);
  assert.equal(s.phase, 'signal');
  assert.equal(s.signal.dir, 'up');
  assert.deepEqual(s.entryWait, { leftMs: 5000, totalMs: 5000 });
  assert.equal(s.remainingMs, 5000); // lo que queda para entrar
  assert.equal(s.follow, null); // aún no hay operación que vaya ganando o perdiendo
  // Pasan los 3 s del plazo sin que el usuario entre: NO se califica nada.
  s = read(110, 3000);
  assert.equal(s.phase, 'signal');
  assert.equal(s.entryWait.leftMs, 2000);
  assert.equal(s.lastResult, '');
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(t.predict(), false);
});

test('etapa 2: en cuanto entra, el plazo cuenta desde ahí y se mide contra el precio de SU entrada', () => {
  const { read } = make();
  read(112, 0); // señal ARRIBA con el precio en 112
  let s = read(113, 2000, true); // el usuario entra 2 s después, con el precio ya en 113
  assert.equal(s.entryWait, null);
  assert.equal(s.enteredAgoMs, 0);
  assert.equal(s.follow.state, 'igual');
  assert.equal(s.remainingMs, 3000 - LAG); // 3 s desde la entrada (la marca se confirma un poco después de entrar)
  s = read(112.5, 3500);
  assert.equal(s.phase, 'signal'); // a los 3 s de la SEÑAL no pasa nada: cuenta desde la entrada
  assert.equal(s.follow.state, 'perdiendo'); // contra 113, no contra 112
  s = read(112.5, 4700);
  assert.equal(s.phase, 'idle');
  // Contra el precio de la señal (112) habría "acertado"; contra su entrada real (113), perdió.
  assert.equal(s.lastResult, 'falló');
  assert.deepEqual(tally(s), [0, 1, 0]);
});

test('si no entra en el tiempo de espera, no hay operación: ni resultado ni martingala', () => {
  const { t, read } = make({ martin: 1 });
  read(112, 0);
  read(111, 2500);
  const s = read(110, 5000);
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /^sin entrada: no vi tu operación en 5 s/);
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(s.signal, null); // no salió martingala: no se perdió nada
  assert.equal(s.ready, true);
  assert.equal(t.predict(), true);
});

test('una marca vista fuera de la espera de entrada no cambia nada', () => {
  const { read } = make();
  read(112, 0);
  read(112, 1000, true); // entra
  let s = read(113, 1500, true); // otra marca (p. ej. un doble clic): la operación en curso sigue igual
  assert.equal(s.remainingMs, 2500 - LAG);
  s = read(114, 3700);
  assert.equal(s.lastResult, 'acertó');
});

test('la martingala también pasa por las dos etapas: espera la entrada y cuenta desde ahí', () => {
  const { read } = make({ martin: 1 });
  read(112, 0);
  read(112, 1000, true); // entra en 112
  let s = read(110, 3700); // 3 s después de su entrada: perdió
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.signal.source, 'martingala');
  assert.equal(s.signal.dir, 'down');
  assert.deepEqual(s.entryWait, { leftMs: 5000, totalMs: 5000 }); // otra vez: espera de entrada
  assert.equal(s.follow, null);
  s = read(109.5, 5000, true); // entra a la martingala en 109.5
  assert.equal(s.entryWait, null);
  assert.equal(s.follow.level, 1);
  s = read(108, 7700);
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'acertó'); // ABAJO desde 109.5 y terminó en 108
  assert.deepEqual(tally(s), [1, 1, 0]);
});

test('si no entra a la martingala, se suelta a los 5 s sin contar nada', () => {
  const { read } = make({ martin: 2 });
  read(112, 0);
  read(112, 500, true);
  read(110, 3200); // perdió: martingala 1, esperando entrada
  const s = read(109, 8200);
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /^sin entrada/);
  assert.deepEqual(tally(s), [0, 1, 0]);
});

test('ESPERAR (sin lado) no espera ninguna entrada', () => {
  const { read } = make({ candles: FLAT });
  let s = read(101, 0);
  assert.equal(s.signal.dir, null);
  assert.equal(s.entryWait, null);
  s = read(101, 3000);
  assert.equal(s.phase, 'idle');
  assert.match(s.lastResult, /^no dio predicción/);
});

test('con la espera en 0 todo cuenta desde la señal, como antes', () => {
  const { read } = make({ wait: 0 });
  let s = read(112, 0);
  assert.equal(s.entryWait, null);
  assert.equal(s.remainingMs, 3000);
  s = read(114, 3000);
  assert.equal(s.lastResult, 'acertó');
});

// ---------- Con el bot: la entrada y el resultado los da la plataforma ----------
const withBot = ({ martin = 0 } = {}) => {
  const t = createTimedTracker();
  t.predict();
  const read = (price, now, extra = {}) =>
    t.update({ candles: UP, priceY: row(price), now, cycleMs: 3000, payout: 92, manual: true, martin, entryWaitMs: 5000, quote: { value: price, perPixel: 1 }, ...extra });
  return { t, read };
};

test('bot: la entrada cuenta desde la hora exacta que da el bot y contra su precio de entrada', () => {
  const { read } = withBot();
  read(112, 0);
  // El bot entró hace 250 ms, en 112.4 (el panel ve 113 en esta lectura).
  let s = read(113, 600, { userEntered: { price: 112.4, agoMs: 250 }, externalAwait: true });
  assert.equal(s.entryWait, null);
  assert.equal(s.remainingMs, 3000 - 250);
  assert.equal(s.follow.state, 'ganando'); // 113 contra 112.4, no contra 113
  s = read(111.5, 2000, { externalAwait: true });
  assert.equal(s.follow.state, 'perdiendo'); // 111.5 contra 112.4
});

test('bot: el resultado que da la plataforma manda, aunque el precio del panel diga otra cosa', () => {
  const { read } = withBot();
  read(112, 0);
  read(112, 500, { userEntered: { price: 112, agoMs: 100 }, externalAwait: true });
  // El panel ve el precio arriba (para él, "acertó"), pero Pocket cerró la operación como perdida.
  const s = read(114, 3300, { externalAwait: true, externalResult: 'loss' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.lastResult, 'falló');
  assert.deepEqual(tally(s), [0, 1, 0]);
});

test('bot: al terminar el plazo se espera un momento el resultado de la plataforma', () => {
  const { read } = withBot();
  read(112, 0);
  read(112, 500, { userEntered: { price: 112, agoMs: 0 }, externalAwait: true });
  let s = read(114, 3600, { externalAwait: true }); // ya pasaron los 3 s, pero Pocket aún no contesta
  assert.equal(s.phase, 'signal');
  s = read(114, 4000, { externalAwait: true, externalResult: 'win' });
  assert.equal(s.lastResult, 'acertó');
  // Si la plataforma no contesta en 2.5 s, se califica con el precio propio.
  const other = withBot();
  other.read(112, 0);
  other.read(112, 500, { userEntered: { price: 112, agoMs: 0 }, externalAwait: true });
  s = other.read(111, 3500 + EXTERNAL_WAIT_MS, { externalAwait: true });
  assert.equal(s.lastResult, 'falló');
});

test('bot: si Pocket dice que perdió, sale la martingala; si empata, no', () => {
  const { read } = withBot({ martin: 1 });
  read(112, 0);
  read(112, 500, { userEntered: { price: 112, agoMs: 0 }, externalAwait: true });
  let s = read(113, 3400, { externalAwait: true, externalResult: 'loss' });
  assert.equal(s.lastResult, 'falló');
  assert.equal(s.signal.source, 'martingala');
  assert.ok(s.entryWait, 'la martingala espera su entrada (la del bot)');
  // El resultado viejo no se le aplica a la martingala: quien llama solo lo pasa para SU operación.
  s = read(113, 3700);
  assert.equal(s.phase, 'signal');

  const tie = withBot({ martin: 1 });
  tie.read(112, 0);
  tie.read(112, 500, { userEntered: { price: 112, agoMs: 0 }, externalAwait: true });
  s = tie.read(110, 3400, { externalAwait: true, externalResult: 'tie' });
  assert.equal(s.lastResult, 'empate');
  assert.equal(s.phase, 'idle');
});
