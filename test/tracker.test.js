const test = require('node:test');
const assert = require('node:assert/strict');
const { signalFor, rsi, MIN_CANDLES } = require('../src/signal');
const { createTracker, closedSince, backtest } = require('../src/tracker');
const { summarize, wilsonLow } = require('../src/score');
const { chain } = require('./helpers');

test('señal: necesita un mínimo de velas', () => {
  assert.equal(signalFor(chain([1, 2, 1])).dir, null);
  assert.equal(MIN_CANDLES, 8);
});

test('señal: sigue la tendencia y respeta el RSI', () => {
  // Subida con retrocesos (RSI por debajo de 75) -> arriba
  assert.equal(signalFor(chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 2])).dir, 'up');
  // Bajada con rebotes -> abajo
  assert.equal(signalFor(chain([-3, 2, -4, 3, -3, 2, -4, 3, -3, -2])).dir, 'down');
  // Subida sin un solo retroceso: RSI 100 (sobrecompra) -> esperar
  const straightUp = signalFor(chain([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]));
  assert.equal(straightUp.dir, null);
  assert.equal(straightUp.trend, 'up');
  assert.equal(rsi([1, 2, 3, 4], 7), 100);
  assert.equal(rsi([4, 3, 2, 1], 7), 0);
  assert.equal(rsi([5, 5, 5], 7), 50);
});

test('detecta cuántas velas cerraron aunque la gráfica se desplace o cambie de escala', () => {
  const moves = [3, -2, 4, -1, 3, -2, 4, -1, 3, 2, -5, 1, 6, -2];
  const all = chain(moves);
  const before = all.slice(0, 11);
  assert.equal(closedSince(before, all.slice(0, 11)), 0);
  assert.equal(closedSince(before, all.slice(0, 12)), 1);
  assert.equal(closedSince(before, all.slice(2, 13)), 2); // se desplazó y cerraron dos
  assert.equal(closedSince(before, chain(moves, 1.7).slice(1, 12)), 1); // otra escala vertical
  // La última vela conocida dejó de verse un momento: no es nada nuevo
  assert.equal(closedSince(before, all.slice(0, 10)), -1);
  // Otra gráfica distinta: no se puede empatar
  assert.equal(closedSince(before, chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4, 4])), null);
});

test('el marcador califica cada señal una sola vez', () => {
  const moves = [3, -2, 4, -1, 3, -2, 4, -1, 3, 2, 4, -6, 2, 3, 0, 1];
  const all = chain(moves);
  const tracker = createTracker();
  const expected = { wins: 0, losses: 0, ties: 0 };
  let state;
  // En cada lectura la última vela es la que está "en curso"; se repite la lectura para simular varios escaneos.
  for (let n = 9; n <= all.length; n++) {
    for (let repeat = 0; repeat < 3; repeat++) state = tracker.update(all.slice(0, n), 85);
    // Al leer n velas cerró la de índice n-2: la califica la señal dada con las velas 0..n-3.
    if (n > 9) {
      const signal = signalFor(all.slice(0, n - 2));
      const closed = all[n - 2];
      if (signal.dir) {
        if (closed.dir === 'flat') expected.ties++;
        else if (closed.dir === signal.dir) expected.wins++;
        else expected.losses++;
      }
    }
  }
  assert.deepEqual({ wins: state.live.wins, losses: state.live.losses, ties: state.live.ties }, expected);
  assert.ok(expected.wins + expected.losses + expected.ties >= 3, 'la prueba debe calificar varias señales');
  assert.equal(state.status, 'ok');
});

test('una vela que parpadea (se tapa y reaparece) no se califica dos veces', () => {
  // Caso real: un globo de la plataforma tapa la última vela o aparece como vela falsa.
  const all = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 2, 4, -6, 2]);
  const steady = createTracker();
  const flicker = createTracker();
  let a;
  let b;
  for (let n = 10; n <= all.length; n++) {
    a = steady.update(all.slice(0, n), 85);
    for (let i = 0; i < 4; i++) {
      b = flicker.update(all.slice(0, n), 85);
      b = flicker.update(all.slice(0, n - 1), 85); // la última vela deja de verse
    }
    b = flicker.update(all.slice(0, n), 85);
  }
  const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
  assert.deepEqual(tally(b), tally(a));
  assert.ok(a.live.wins + a.live.losses >= 2);
});

test('si la gráfica cambia, se re-sincroniza sin anotar nada', () => {
  const tracker = createTracker();
  tracker.update(chain([3, -2, 4, -1, 3, -2, 4, -1, 3, 2, 1]), 85);
  const state = tracker.update(chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4, 4]), 85);
  assert.equal(state.status, 'resync');
  assert.equal(state.live.wins + state.live.losses + state.live.ties, 0);
  assert.equal(tracker.update([], 85).status, 'no-chart');
});

test('repaso de las velas visibles', () => {
  const all = chain([3, -2, 4, -1, 3, -2, 4, -1, 3, 2, 4, -6, 2, 3]);
  const score = backtest(all);
  let n = 0;
  for (let i = MIN_CANDLES - 1; i < all.length - 1; i++) if (signalFor(all.slice(0, i + 1)).dir) n++;
  assert.equal(score.wins + score.losses + score.ties, n);
});

test('resumen: porcentaje mínimo, dinero simulado y veredicto', () => {
  const few = summarize({ wins: 6, losses: 4, ties: 0 }, 85);
  assert.equal(few.hitRate, 60);
  assert.equal(few.breakEven, 54.1); // 100 / 185
  assert.equal(few.simulated, 1.1); // 6 * 0.85 - 4
  assert.match(few.verdict, /todavía no se puede concluir/);

  assert.match(summarize({ wins: 50, losses: 50, ties: 0 }, 85).verdict, /se pierde dinero/);
  assert.equal(summarize({ wins: 50, losses: 50, ties: 0 }, 85).simulated, -7.5);
  assert.match(summarize({ wins: 58, losses: 42, ties: 0 }, 85).verdict, /pura suerte/);
  assert.match(summarize({ wins: 700, losses: 300, ties: 0 }, 85).verdict, /sobre el mínimo/);
  assert.equal(summarize({ wins: 0, losses: 0, ties: 0 }, 85).hitRate, null);
  assert.ok(wilsonLow(58, 100) < 0.541 && wilsonLow(700, 1000) > 0.541);

  // Con pago de 48 % hay que acertar más de dos de cada tres
  const low = summarize({ wins: 31, losses: 16, ties: 0 }, 48);
  assert.equal(low.breakEven, 67.6);
  assert.equal(low.hitRate, 66);
  assert.match(low.verdict, /se pierde dinero/);
  assert.equal(low.simulated, -1.12); // 31 * 0.48 - 16
});
