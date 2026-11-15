const test = require('node:test');
const assert = require('node:assert/strict');
const { findVertical, antiRebound, MAX_AFTER } = require('../src/rebound');
const { patternOf, PATTERN_KEYS, flip } = require('../src/formations');

// Vela de prueba: apertura, cierre y mechas (arriba, abajo).
const k = (open, close, up = 0.5, down = 0.5) => ({
  open,
  close,
  high: Math.max(open, close) + up,
  low: Math.min(open, close) - down,
  dir: close > open ? 'up' : close < open ? 'down' : 'flat',
});
/** n velas tranquilas (cuerpo de 1) alternando verde y roja alrededor de 100. */
function calm(n) {
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const d = i % 2 ? -1 : 1;
    out.push(k(price, price + d));
    price += d;
  }
  return out;
}
// Vertical hacia arriba: dos velas verdes con cuerpo de 4 (lo normal es 1) hasta 108.
const BIG = [k(100, 104), k(104, 108)];
const FRESH = [...calm(12), ...BIG, k(108, 108.4)]; // recién hecha: la vela en curso apenas empieza

// ---------- La vertical ----------
test('vertical: 2 velas grandes seguidas del mismo color que marcan extremo de 20 velas', () => {
  const v = findVertical(FRESH);
  assert.ok(v);
  assert.equal(v.dir, 'up');
  assert.equal(v.length, 2);
  assert.equal(v.includesForming, false);
  assert.equal(v.after.length, 0);
  assert.ok(v.ratios.every((r) => r >= 1.5), `cuerpos ${v.ratios}`);
  assert.equal(v.extreme, 108.5);
});

test('una sola vela grande, o dos que no marcan extremo, no son vertical', () => {
  assert.equal(findVertical([...calm(12), k(100, 104), k(104, 104.3)]), null);
  // Antes hubo un máximo más alto (mecha hasta 121): las dos grandes no marcan extremo nuevo.
  const history = calm(12);
  history[3] = k(history[3].open, history[3].close, 20, 0.5);
  assert.equal(findVertical([...history, ...BIG, k(108, 108.4)]), null);
  // Con muy pocas velas antes no hay con qué comparar.
  assert.equal(findVertical([...calm(4), ...BIG, k(108, 108.4)]), null);
});

test('la vela en curso cuenta como parte de la vertical si ya es grande', () => {
  const v = findVertical([...calm(12), k(100, 104), k(104, 108)]);
  assert.ok(v);
  assert.equal(v.includesForming, true);
  assert.equal(v.length, 2);
});

// ---------- El veto ----------
test('recién hecha la vertical: se veta la señal en su misma dirección, no la contraria', () => {
  const same = antiRebound({ candles: FRESH, dir: 'up' });
  assert.equal(same.veto, true);
  assert.match(same.reason, /^Veto anti-rebote: 2 velas verdes grandes seguidas/);
  assert.match(same.reason, /No se entra ARRIBA/);
  assert.equal(same.data.velas, 2);
  assert.equal(same.data.cuerpos.length, 2);
  assert.equal(same.data.extremo, 'máximo');
  assert.equal(same.data.despues, 0);
  assert.equal(antiRebound({ candles: FRESH, dir: 'down' }).veto, false);
  assert.equal(antiRebound({ candles: FRESH, dir: null }).veto, false);
  assert.equal(antiRebound({ candles: calm(16), dir: 'up' }).veto, false); // sin vertical no hay nada que vetar
});

test('lo mismo hacia abajo (gráfica volteada)', () => {
  const down = flip(FRESH);
  const check = antiRebound({ candles: down, dir: 'down' });
  assert.equal(check.veto, true);
  assert.match(check.reason, /2 velas rojas grandes seguidas/);
  assert.equal(check.data.extremo, 'mínimo');
  assert.equal(antiRebound({ candles: down, dir: 'up' }).veto, false);
});

test('excepción: base de 3 velas tras la vertical y rompimiento de esa base', () => {
  const base = [k(108, 107.5), k(107.5, 108), k(108, 107.6)];
  // Todavía dentro de la base: sigue vetado.
  const inside = antiRebound({ candles: [...calm(12), ...BIG, ...base, k(107.6, 107.9)], dir: 'up' });
  assert.equal(inside.veto, true);
  assert.match(inside.reason, /todavía no hay base ni retroceso confirmado/);
  // El precio rompe el techo de la base (108.5): continuación, se permite.
  const broke = antiRebound({ candles: [...calm(12), ...BIG, ...base, k(107.6, 109.2)], dir: 'up' });
  assert.equal(broke.veto, false);
  assert.equal(broke.allowed, 'base');
  // Con solo 2 velas de base no basta.
  const short = antiRebound({ candles: [...calm(12), ...BIG, ...base.slice(0, 2), k(108, 109.2)], dir: 'up' });
  assert.equal(short.veto, true);
});

test('excepción: retroceso superficial (< 38 %) que sostiene y vela de confirmación', () => {
  const pullback = [k(108, 107), k(107, 108.8)]; // baja un poco y la siguiente cierra sobre el máximo anterior
  const ok = antiRebound({ candles: [...calm(12), ...BIG, ...pullback, k(108.8, 109)], dir: 'up' });
  assert.equal(ok.veto, false);
  assert.equal(ok.allowed, 'pullback');
  assert.ok(ok.data.retroceso < 38, `retroceso ${ok.data.retroceso}`);
  // Sin vela de confirmación (la última cerrada no supera el máximo de la anterior): vetado.
  const weak = antiRebound({ candles: [...calm(12), ...BIG, k(108, 107), k(107, 107.8), k(107.8, 108)], dir: 'up' });
  assert.equal(weak.veto, true);
});

test('si el precio ya devolvió 38 % o más, entrar ya no es perseguir la vertical: no se veta', () => {
  const deep = antiRebound({ candles: [...calm(12), ...BIG, k(108, 104), k(104, 104.5)], dir: 'up' });
  assert.equal(deep.veto, false);
  assert.equal(deep.allowed, 'profundo');
  assert.ok(deep.data.retroceso >= 38);
});

test(`pasadas ${MAX_AFTER} velas cerradas la vertical ya no cuenta`, () => {
  const tail = Array.from({ length: MAX_AFTER + 1 }, (_, i) => k(108, 108 + (i % 2 ? -0.3 : 0.3), 0.2, 0.2));
  const old = [...calm(12), ...BIG, ...tail, k(108, 108.2, 0.2, 0.2)];
  assert.equal(findVertical(old), null);
  assert.equal(antiRebound({ candles: old, dir: 'up' }).veto, false);
});

// ---------- Patrón de la señal ----------
test('patrón: reversa (contra la vertical) y rompimiento (a favor de ella)', () => {
  assert.equal(patternOf({ candles: FRESH, dir: 'down' }).key, 'reversa');
  assert.equal(patternOf({ candles: FRESH, dir: 'up' }).key, 'rompimiento');
  // Volteado: contra una vertical bajista es reversa; a favor, rompimiento.
  assert.equal(patternOf({ candles: flip(FRESH), dir: 'up' }).key, 'reversa');
  assert.equal(patternOf({ candles: flip(FRESH), dir: 'down' }).key, 'rompimiento');
});

test('patrón: rompimiento cuando el precio sale del rango de las 20 velas previas', () => {
  const p = patternOf({ candles: [...calm(20), k(100, 103)], dir: 'up' });
  assert.equal(p.key, 'rompimiento');
  assert.equal(p.text, 'rompimiento');
});

test('patrón: rechazo en extremo (mecha larga en el mínimo o en el máximo de 20 velas)', () => {
  const low = patternOf({ candles: [...calm(20), k(100, 100.3, 0.2, 3)], dir: 'up' });
  assert.equal(low.key, 'rechazo');
  const high = patternOf({ candles: [...calm(20), k(100, 99.7, 3, 0.2)], dir: 'down' });
  assert.equal(high.key, 'rechazo');
});

test('patrón: tendencia (escalera a favor) y reversa (contra la escalera)', () => {
  const stairs = [...calm(14), k(100, 101.2), k(101.2, 102.4), k(102.4, 103.6), k(103.6, 104.8), k(104.8, 105.1)];
  assert.equal(findVertical(stairs), null); // cuerpos normales: no es una vertical
  assert.equal(patternOf({ candles: stairs, dir: 'up' }).key, 'tendencia');
  assert.equal(patternOf({ candles: stairs, dir: 'down' }).key, 'reversa');
});

test('patrón: rango cuando el precio está encerrado, y otro cuando no es nada de lo anterior', () => {
  assert.equal(patternOf({ candles: [...calm(20), k(100, 100.4)], dir: 'up' }).key, 'rango');
  // Sube a tirones (dos arriba, dos abajo), sin escalera, sin extremo y sin cuerpos grandes.
  const drift = [];
  let price = 100;
  for (let i = 0; i < 20; i++) {
    const d = i % 4 < 2 ? 2.4 : -1;
    drift.push(k(price, price + d));
    price += d;
  }
  drift.push(k(price, price - 0.3));
  assert.equal(patternOf({ candles: drift, dir: 'up' }).key, 'otro');
  // Sin lado o con muy pocas velas no se clasifica.
  assert.equal(patternOf({ candles: FRESH, dir: null }).key, 'otro');
  assert.equal(patternOf({ candles: calm(5), dir: 'up' }).key, 'otro');
  assert.deepEqual(PATTERN_KEYS, ['rompimiento', 'rechazo', 'tendencia', 'reversa', 'rango', 'otro']);
});
