// Seguimiento de la vela actual en una zona (16 nov 2026): nunca se marca una vela anterior.
const test = require('node:test');
const assert = require('node:assert');
const { trackZone, pitchOf } = require('../src/zonetrack');

// Velas del bot en precios y su dibujo en pantalla: fila = 400 − (precio − 100) × 1000; unidades de pantalla = −fila.
const A = -500;
const B = 1; // unidades de pantalla = −fila = −400 + (precio − 100) × 1000 → con precios ×1000: valor = A + B × p
const prices = [];
let p = 100200;
for (let i = 0; i < 20; i++) {
  const open = p;
  const close = p + (i % 3 === 0 ? -35 : 28) + (i % 5) * 3;
  prices.push({ open, close, high: Math.max(open, close) + 9 + (i % 4), low: Math.min(open, close) - 7 - (i % 3) });
  p = close;
}
const toPx = (c, i) => ({ x0: 20 + i * 14, x1: 20 + i * 14 + 9, open: A + B * c.open, close: A + B * c.close, high: A + B * c.high, low: A + B * c.low, dir: c.close >= c.open ? 'up' : 'down' });
const closed = prices.slice(0, 19);
const forming = prices[19];
const book = { closed, forming, openFor: 6 };
const screenAll = prices.map(toPx); // la pantalla ve las 19 cerradas y la que va en curso
const screenNoForming = closed.map(toPx); // la vela en curso no se detecta (recien abierta, o tapada)

test('la separacion entre velas se mide de las ultimas vistas', () => {
  assert.strictEqual(pitchOf(screenAll), 14);
  assert.strictEqual(pitchOf(screenAll.slice(0, 1)), 0);
});

test('si la pantalla ve la vela en curso, se marca en su sitio y con los precios del bot', () => {
  const out = trackZone({ candles: screenAll, book, now: 100000 });
  assert.ok(out.exact && out.current);
  assert.strictEqual(out.current.x0, screenAll[19].x0);
  assert.strictEqual(out.marks.length, 19);
  assert.ok(Math.abs(out.current.close - (A + B * forming.close)) < 0.5);
});

test('si la pantalla NO ve la vela en curso, va un paso a la derecha: no se marca la anterior', () => {
  const out = trackZone({ candles: screenNoForming, book, now: 100000 });
  assert.ok(out.exact && out.current);
  assert.strictEqual(out.current.x0, screenNoForming[18].x0 + 14);
  assert.strictEqual(out.marks.length, 19); // todas las vistas son cerradas
  assert.ok(Math.abs(out.current.open - (A + B * forming.open)) < 0.5);
});

test('una lectura que no cuadra sostiene el ultimo dibujo unos segundos y despues lo quita', () => {
  const first = trackZone({ candles: screenAll, book, now: 100000 });
  const junk = screenAll.map((c, i) => ({ ...c, open: c.open + (i % 2 ? 60 : -45), close: c.close - (i % 3) * 40, high: c.high + 80, low: c.low - (i % 4) * 30 }));
  const held = trackZone({ candles: junk, book, prev: first.track, now: 101000 });
  assert.ok(held.current, 'se sostiene');
  assert.strictEqual(held.current.x0, first.current.x0);
  const gone = trackZone({ candles: junk, book, prev: held.track, now: 100000 + 4500 });
  assert.strictEqual(gone.current, null);
});

test('una lectura a media animacion (todo corrido unos pixeles) no deja el recuadro desfasado', () => {
  const first = trackZone({ candles: screenNoForming, book, now: 100000 });
  const mid = screenNoForming.map((c) => ({ ...c, x0: c.x0 + 6, x1: c.x1 + 6 })); // la grafica va recorriendose
  const moving = trackZone({ candles: mid, book, prev: first.track, now: 100350 });
  assert.strictEqual(moving.current.x0, first.current.x0 + 6); // acompaña a la grafica en ese instante
  const after = trackZone({ candles: screenNoForming, book, prev: moving.track, now: 100700 });
  assert.strictEqual(after.current.x0, first.current.x0); // y vuelve a su casilla: no se queda corrido
});

test('lo que queda a la derecha de la casilla (un globo de resultado) no se toma por la vela actual', () => {
  const bubble = { x0: screenNoForming[18].x0 + 40, x1: screenNoForming[18].x0 + 52, open: 100300 + A, close: 100340 + A, high: 100345 + A, low: 100295 + A, dir: 'up' };
  const out = trackZone({ candles: [...screenNoForming, bubble], book, now: 100000 });
  assert.ok(out.current);
  assert.strictEqual(out.current.x0, screenNoForming[18].x0 + 14);
  assert.strictEqual(out.current.seen, false);
  assert.strictEqual(out.marks.length, 19);
});

test('sin velas del bot se usa la mas a la derecha (como antes)', () => {
  const out = trackZone({ candles: screenAll, book: null, now: 1 });
  assert.strictEqual(out.exact, false);
  assert.strictEqual(out.current.x0, screenAll[19].x0);
});

test('con la grafica en M10 (velas de 30 s) tambien se sigue la vela actual', () => {
  const { widerBooks } = require('../src/zonetrack');
  // 41 velas de 15 s; la pantalla las pinta de 2 en 2. La vela de 30 s en curso lleva una de 15 s cerrada y la que va.
  const small = [];
  let q = 100200;
  for (let i = 0; i < 41; i++) {
    const open = q;
    const close = q + (i % 3 === 0 ? -35 : 28) + (i % 5) * 3;
    small.push({ open, close, high: Math.max(open, close) + 9 + (i % 4), low: Math.min(open, close) - 7 - (i % 3) });
    q = close;
  }
  const book30 = { closed: small.slice(0, 40), forming: small[40], openFor: 4 };
  const big = widerBooks(book30, 2)[1]; // lead 1: la de 30 s en curso = la ultima cerrada de 15 s + la que va
  assert.strictEqual(big.seconds, 30);
  const screen = [...big.closed, big.forming].map(toPx);
  const out = trackZone({ candles: screen, book: book30, now: 100000 });
  assert.ok(out.exact && out.current, 'se ubica aunque la pantalla pinte velas de 30 s');
  assert.strictEqual(out.seconds, 30);
  assert.strictEqual(out.current.x0, screen[screen.length - 1].x0);
  assert.ok(Math.abs(out.current.open - (A + B * big.forming.open)) < 0.5);
  assert.ok(Math.abs(out.current.close - (A + B * small[40].close)) < 0.5);
});

test('si la ultima vela cerrada es un doji que la pantalla no detecta, el recuadro sigue en la vela actual', () => {
  // la pantalla ve todas menos la ultima cerrada (indice 18); la vela en curso (19) si se ve
  const gap = screenAll.filter((_, i) => i !== 18);
  const out = trackZone({ candles: gap, book, now: 100000 });
  assert.ok(out.exact && out.current);
  assert.strictEqual(out.current.x0, screenAll[19].x0);
  assert.strictEqual(out.current.seen, true);
});

test('un globo del mismo color encima de la casilla no se toma por la vela: se dibuja con los precios del bot', () => {
  const fake = { ...screenAll[19], high: screenAll[19].high + 90, low: screenAll[19].low - 60, open: screenAll[19].low - 55, close: screenAll[19].high + 85 };
  const out = trackZone({ candles: [...screenNoForming, fake], book, now: 100000 });
  assert.ok(out.current);
  assert.strictEqual(out.current.seen, false);
  assert.ok(Math.abs(out.current.close - (A + B * forming.close)) < 0.5);
});
