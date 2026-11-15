const test = require('node:test');
const assert = require('node:assert/strict');
const { patternStats, breakEvenOf, PATTERN_WINDOW, PATTERN_VETO_MIN } = require('../src/score');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

const ops = (pattern, wins, losses, payout = 92, ties = 0) => [
  ...Array.from({ length: wins }, () => ({ pattern, result: 'win', payout })),
  ...Array.from({ length: losses }, () => ({ pattern, result: 'loss', payout })),
  ...Array.from({ length: ties }, () => ({ pattern, result: 'tie', payout })),
];

// ---------- Estadística por patrón ----------
test('punto de equilibrio según el pago', () => {
  assert.equal(Math.round(breakEvenOf(92) * 1000) / 10, 52.1);
  assert.equal(Math.round(breakEvenOf(58) * 1000) / 10, 63.3);
  assert.equal(Math.round(breakEvenOf(38) * 1000) / 10, 72.5);
  assert.equal(PATTERN_WINDOW, 100);
  assert.equal(PATTERN_VETO_MIN, 20);
});

test('acierto, P&L y punto de equilibrio por patrón', () => {
  const s = patternStats([...ops('tendencia', 12, 12, 92, 3), ...ops('rango', 11, 9)]);
  assert.deepEqual(Object.keys(s).sort(), ['rango', 'tendencia']);
  const t = s.tendencia;
  assert.equal(t.n, 27);
  assert.equal(t.decided, 24); // los empates no cuentan para el acierto
  assert.equal(t.accuracy, 50);
  assert.equal(t.breakEven, 52.1);
  assert.equal(t.avgPayout, 92);
  assert.equal(t.pnl, Math.round((12 * 0.92 - 12) * 100) / 100); // -0.96
  assert.equal(s.rango.accuracy, 55);
  assert.equal(s.rango.pnl, Math.round((11 * 0.92 - 9) * 100) / 100); // +1.12
});

test('auto-veto: 20 o más operaciones decididas y acierto bajo el punto de equilibrio', () => {
  const s = patternStats([...ops('tendencia', 12, 12), ...ops('rango', 11, 9), ...ops('rechazo', 9, 10), ...ops('otro', 2, 30)]);
  assert.equal(s.tendencia.vetoed, true); // 50 % < 52.1 % con 24
  assert.equal(s.rango.vetoed, false); // 55 % >= 52.1 %
  assert.equal(s.rechazo.vetoed, false); // va mal (47 %), pero solo lleva 19
  assert.equal(s.otro.vetoed, true);
  // El mínimo de operaciones se puede cambiar.
  assert.equal(patternStats(ops('rechazo', 9, 10), { vetoMin: 10 }).rechazo.vetoed, true);
});

test('el punto de equilibrio sale del pago REAL promedio: con pago bajo hace falta acertar más', () => {
  // 60 % de acierto: de sobra con pago de 92 %, insuficiente con pago de 58 % (necesita 63.3 %).
  assert.equal(patternStats(ops('reversa', 18, 12, 92)).reversa.vetoed, false);
  const low = patternStats(ops('reversa', 18, 12, 58)).reversa;
  assert.equal(low.breakEven, 63.3);
  assert.equal(low.vetoed, true);
  assert.equal(low.pnl, Math.round((18 * 0.58 - 12) * 100) / 100);
  // Pagos mezclados: cuenta el promedio.
  const mixed = patternStats([...ops('reversa', 10, 10, 92), ...ops('reversa', 10, 10, 38)]).reversa;
  assert.equal(mixed.avgPayout, 65);
});

test('solo cuentan las últimas 100 operaciones de cada patrón', () => {
  // 60 fallos viejos y luego 100 operaciones buenas: los viejos ya no pesan.
  const s = patternStats([...ops('rango', 0, 60), ...ops('rango', 70, 30)]).rango;
  assert.equal(s.n, 100);
  assert.equal(s.accuracy, 70);
  assert.equal(s.vetoed, false);
  assert.deepEqual(patternStats([]), {});
});

// ---------- En el marcador: patrón de cada señal y los dos vetos ----------
const row = (price) => -price;
const last = (candles) => candles[candles.length - 1];
// 12 velas tranquilas, una vertical de dos velas grandes hacia arriba y la vela en curso recién
// abierta (con mechas cortas: las del ayudante `chain` son tan largas que ya serían un retroceso).
const VERTICAL_UP = chain([1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 5, 5, 0.5]).map((c) => ({
  ...c,
  high: Math.max(c.open, c.close) + 0.5,
  low: Math.min(c.open, c.close) - 0.5,
}));
const UP_IA = { dir: 'up', confidence: 'alta', reason: 'tendencia alcista clara' };
const DOWN_IA = { dir: 'down', confidence: 'media', reason: 'rebote probable' };
const start = (candles, advice, extra = {}) => {
  const t = createTimedTracker();
  t.predict();
  const price = last(candles).close;
  const s = t.update({ candles, priceY: row(price), now: 0, cycleMs: 3000, payout: 92, manual: true, advice, ...extra });
  return { t, s, price };
};
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];

test('cada señal lleva su patrón', () => {
  const { s } = start(VERTICAL_UP, DOWN_IA);
  assert.equal(s.signal.dir, 'down');
  assert.equal(s.signal.pattern.key, 'reversa');
  assert.equal(s.signal.veto, null);
  assert.deepEqual(s.vetoResults, []);
});

test('sin activar el anti-rebote la señal pasa igual que antes', () => {
  const { s } = start(VERTICAL_UP, UP_IA);
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.signal.pattern.key, 'rompimiento');
  assert.equal(s.signal.veto, null);
});

test('veto anti-rebote: la señal a favor de la vertical queda en ESPERAR, aunque la IA diga ARRIBA', () => {
  const { s } = start(VERTICAL_UP, UP_IA, { antiRebote: true });
  assert.equal(s.signal.dir, null);
  assert.equal(s.signal.confidence, 'ninguna');
  assert.equal(s.signal.veto.kind, 'anti-rebote');
  assert.equal(s.signal.veto.dir, 'up');
  assert.equal(s.signal.veto.data.velas, 2);
  assert.match(s.signal.reason, /^Veto anti-rebote/);
  // También con "dar siempre un lado": el veto manda.
  assert.equal(start(VERTICAL_UP, UP_IA, { antiRebote: true, force: true }).s.signal.dir, null);
  // La señal contraria (el rebote) no se veta.
  assert.equal(start(VERTICAL_UP, DOWN_IA, { antiRebote: true }).s.signal.dir, 'down');
});

test('la señal vetada se mide en papel al mismo plazo, sin tocar el marcador', () => {
  const { t, price } = start(VERTICAL_UP, UP_IA, { antiRebote: true });
  let s = t.update({ candles: VERTICAL_UP, priceY: row(price + 1), now: 1500, cycleMs: 3000, payout: 92, manual: true, antiRebote: true });
  assert.deepEqual(s.vetoResults, []); // todavía no toca
  s = t.update({ candles: VERTICAL_UP, priceY: row(price + 2), now: 3000, cycleMs: 3000, payout: 92, manual: true, antiRebote: true });
  assert.equal(s.vetoResults.length, 1);
  assert.deepEqual(s.vetoResults[0], { kind: 'anti-rebote', dir: 'up', pattern: 'rompimiento', time: 0, result: 'acertó' });
  assert.deepEqual(tally(s), [0, 0, 0]); // no cuenta como señal dada
  assert.match(s.lastResult, /^no dio predicción/);
  // Se entrega una sola vez.
  s = t.update({ candles: VERTICAL_UP, priceY: row(price + 2), now: 3300, cycleMs: 3000, payout: 92, manual: true, antiRebote: true });
  assert.deepEqual(s.vetoResults, []);
});

test('en papel también se sabe cuando el veto evitó una pérdida', () => {
  const { t, price } = start(VERTICAL_UP, UP_IA, { antiRebote: true });
  const s = t.update({ candles: VERTICAL_UP, priceY: row(price - 2), now: 3000, cycleMs: 3000, payout: 92, manual: true, antiRebote: true });
  assert.equal(s.vetoResults[0].result, 'falló'); // la señal ARRIBA habría perdido: el rebote llegó
});

test('patrón desactivado por estadística: ESPERAR con su motivo, y se mide en papel', () => {
  const vetoedPatterns = { reversa: '45 % en 31 op.; necesita 52.1 %' };
  const { t, s, price } = start(VERTICAL_UP, DOWN_IA, { vetoedPatterns });
  assert.equal(s.signal.dir, null);
  assert.equal(s.signal.veto.kind, 'patron');
  assert.equal(s.signal.veto.pattern, 'reversa');
  assert.match(s.signal.reason, /^Patrón desactivado por estadística: reversa \/ capitulación \(45 % en 31 op\.; necesita 52\.1 %\)\. La señal era ABAJO\./);
  const end = t.update({ candles: VERTICAL_UP, priceY: row(price - 1), now: 3000, cycleMs: 3000, payout: 92, manual: true, vetoedPatterns });
  assert.deepEqual(end.vetoResults, [{ kind: 'patron', dir: 'down', pattern: 'reversa', time: 0, result: 'acertó' }]);
  // Un patrón que no está vetado pasa normal.
  assert.equal(start(VERTICAL_UP, DOWN_IA, { vetoedPatterns: { rango: 'x' } }).s.signal.dir, 'down');
});

test('reset olvida las señales vetadas pendientes', () => {
  const { t, price } = start(VERTICAL_UP, UP_IA, { antiRebote: true });
  t.reset();
  const s = t.update({ candles: VERTICAL_UP, priceY: row(price + 2), now: 3000, cycleMs: 3000, payout: 92, manual: true, antiRebote: true });
  assert.deepEqual(s.vetoResults, []);
});
