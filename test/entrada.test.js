const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, ENTRY_SEEN_LAG_MS: LAG } = require('../src/timed');
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
