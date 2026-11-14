const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimedTracker, AI_STREAK_BRAKE } = require('../src/timed');
const { chain } = require('./helpers');

// Freno para la IA: no seguirla cuando la vela en curso ya está estirada hacia ese lado, o cuando
// ya van 4 o más velas cerradas seguidas de ese color (ver src/timed.js).
const row = (price) => -price;
const last = (candles) => candles[candles.length - 1];
const DOWN_IA = { dir: 'down', confidence: 'alta', reason: 'tendencia bajista clara' };
const UP_IA = { dir: 'up', confidence: 'alta', reason: 'tendencia alcista clara' };
// Velas normales (cuerpos de 2 o 3) y la vela en curso MUY estirada hacia abajo (cuerpo de 8).
const STRETCHED_DOWN = chain([2, -2, 3, -2, 2, -3, 2, -2, 2, -8]);
// Cuatro velas rojas cerradas seguidas y una vela en curso roja de tamaño normal.
const FOUR_RED = chain([2, -2, 3, -2, 2, 3, -2, -2, -3, -2, -2]);
// Velas alternadas y una vela en curso roja normal: nada que frenar.
const NORMAL = chain([2, -2, 3, -2, 2, -3, 2, -2, 2, -2]);

const signal = (candles, advice, extra = {}) => {
  const t = createTimedTracker();
  t.predict();
  return t.update({ candles, priceY: row(last(candles).close), now: 0, cycleMs: 3000, payout: 92, manual: true, advice, ...extra }).signal;
};

test('la constante: 4 velas seguidas', () => {
  assert.equal(AI_STREAK_BRAKE, 4);
});

test('vela en curso ya estirada hacia abajo y la IA dice ABAJO: se frena y queda en ESPERAR', () => {
  const s = signal(STRETCHED_DOWN, DOWN_IA);
  assert.equal(s.dir, null);
  assert.equal(s.confidence, 'ninguna');
  assert.equal(s.braked, true);
  assert.match(s.reason, /^Freno: la vela en curso está ya muy extendida hacia abajo/);
  assert.match(s.reason, /La IA decía ABAJO/);
});

test('cuatro velas rojas seguidas y la IA dice ABAJO: se frena', () => {
  const s = signal(FOUR_RED, DOWN_IA);
  assert.equal(s.dir, null);
  assert.equal(s.braked, true);
  assert.match(s.reason, /^Freno: ya van 4 velas rojas seguidas/);
});

test('si la IA va CONTRA el movimiento (el rebote), no se frena', () => {
  assert.equal(signal(STRETCHED_DOWN, UP_IA).dir, 'up');
  const s = signal(FOUR_RED, UP_IA);
  assert.equal(s.dir, 'up');
  assert.equal(s.confidence, 'alta');
  assert.equal(s.braked, false);
});

test('con velas normales la señal de la IA pasa tal cual', () => {
  const s = signal(NORMAL, DOWN_IA);
  assert.equal(s.dir, 'down');
  assert.equal(s.source, 'ia');
  assert.equal(s.confidence, 'alta');
  assert.equal(s.braked, false);
});

test('con "dar siempre un lado" se conserva el lado de la IA, pero como confianza baja', () => {
  const s = signal(FOUR_RED, DOWN_IA, { force: true });
  assert.equal(s.dir, 'down');
  assert.equal(s.confidence, 'baja');
  assert.equal(s.braked, true);
  assert.match(s.reason, /^Freno: ya van 4 velas rojas seguidas/);
});

test('si está medido que el precio viene CONTINUANDO, el freno no aplica', () => {
  const s = signal(FOUR_RED, DOWN_IA, { regime: { kind: 'continua', vote: -1, text: 'continúa 70 %' } });
  assert.equal(s.dir, 'down');
  assert.equal(s.braked, false);
});

test('sin IA (señal de las reglas) este freno no interviene', () => {
  const s = signal(NORMAL, null, { force: true });
  assert.equal(s.source, 'reglas');
  assert.equal(s.braked, false);
});
