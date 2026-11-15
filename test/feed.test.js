const test = require('node:test');
const assert = require('node:assert/strict');
const { createFeed, assetKey, STALE_MS } = require('../src/feed');
const { fitPriceMap, toScreen } = require('../src/pricemap');

// Mensajes con la forma real de la terminal demo (15 nov 2026). El dato binario llega como lo
// entrega CDP: en base64.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const T0 = 1794779400; // múltiplo de 15: ahí abre una vela
function stream(feed, asset, time, price, now) {
  feed.onFrame('451-["updateStream",{"_placeholder":true,"num":0}]', { now });
  feed.onFrame(b64([[asset, time, price]]), { binary: true, now });
}
function history(feed, data, now) {
  feed.onFrame('451-["updateHistoryNewFast",{"_placeholder":true,"num":0}]', { now });
  feed.onFrame(b64(data), { binary: true, now });
}

test('nombres de activo comparables', () => {
  assert.equal(assetKey('EUR/USD OTC'), 'eurusdotc');
  assert.equal(assetKey('EURUSD_otc'), 'eurusdotc');
  assert.equal(assetKey('eur/usd otc '), 'eurusdotc');
  assert.notEqual(assetKey('EUR/USD'), assetKey('EUR/USD OTC'));
});

test('sin datos la fuente lo dice (no inventa nada)', () => {
  const feed = createFeed();
  const s = feed.snapshot({ now: 1000, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(s.ok, false);
  assert.match(s.reason, /aún no entrega datos/);
});

test('precios en vivo: precio actual, edad del dato y vela en curso', () => {
  const feed = createFeed();
  const priceAt = (i) => Number((1.12 + (i % 7) * 0.00001).toFixed(5)); // como llegan: 5 decimales exactos
  let now = 5_000_000;
  // Dos precios por segundo durante 20 s: una vela entera de 15 s y 5 s de la siguiente.
  for (let i = 0; i < 40; i++) {
    stream(feed, 'EURUSD_otc', T0 + i * 0.5 + 0.014, priceAt(i), now);
    now += 500;
  }
  now -= 500;
  const s = feed.snapshot({ now, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(s.ok, true);
  assert.equal(s.asset, 'EURUSD_otc');
  assert.equal(s.ageMs, 0);
  assert.equal(s.stale, false);
  assert.equal(s.price, priceAt(39));
  assert.equal(s.decimals, 5);
  assert.equal(s.closed.length, 1); // la vela de T0 (los precios arrancaron justo al abrir)
  assert.equal(s.closed[0].time, T0);
  assert.equal(s.closed[0].open, 1.12);
  assert.equal(s.closed[0].high, 1.12006);
  assert.equal(s.closed[0].close, priceAt(29));
  assert.equal(s.forming.time, T0 + 15);
  assert.equal(s.forming.open, priceAt(30));
  // Reloj de la vela: lleva ~4.5 s de 15.
  assert.ok(Math.abs(s.clock.elapsedMs - 4514) < 2, `lleva ${s.clock.elapsedMs}`);
  assert.ok(Math.abs(s.clock.elapsedMs + s.clock.remainingMs - 15000) < 1);
  // Pasan 6 s sin datos: la fuente se declara caída.
  const later = feed.snapshot({ now: now + STALE_MS + 1000, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(later.stale, true);
  assert.equal(later.ageMs, STALE_MS + 1000);
});

test('historial: velas del servidor + velas armadas con los precios, sin huecos y en orden', () => {
  const feed = createFeed();
  const now = 9_000_000;
  // Precios desde media vela (T0 + 8 s) hasta T0 + 50 s; velas del servidor hasta la de T0.
  const ticks = [];
  for (let t = T0 + 8; t <= T0 + 50; t += 0.5) ticks.push([t + 0.01, 1.1 + Math.round(Math.sin(t / 7) * 20) * 0.00001]);
  const candles = [
    [T0, 1.1001, 1.1004, 1.1006, 1.1], // [hora, apertura, cierre, máximo, mínimo]
    [T0 - 15, 1.1003, 1.1001, 1.1005, 1.0999],
    [T0 - 30, 1.1, 1.1003, 1.1004, 1.0998],
    [T0 - 60, 1.0995, 1.0997, 1.0999, 1.0994], // hueco: falta la de T0 - 45
  ];
  history(feed, { asset: 'EURUSD_otc', period: 15, history: ticks, candles }, now);
  const s = feed.snapshot({ now, period: 15, asset: 'eurusd otc' });
  assert.equal(s.ok, true);
  // Solo el tramo final sin huecos: T0-30, T0-15, T0 (servidor) y T0+15, T0+30 (armadas).
  assert.deepEqual(s.closed.map((c) => c.time), [T0 - 30, T0 - 15, T0, T0 + 15, T0 + 30]);
  // La vela de T0 es la del servidor (los precios empezaron a media vela, no sirven para armarla).
  assert.deepEqual(s.closed[2], { time: T0, open: 1.1001, close: 1.1004, high: 1.1006, low: 1.1 });
  // Las armadas abren en el primer precio de su tramo y cierran en el último.
  const inBucket = ticks.filter((t) => t[0] >= T0 + 15 && t[0] < T0 + 30).map((t) => t[1]);
  assert.equal(s.closed[3].open, inBucket[0]);
  assert.equal(s.closed[3].close, inBucket[inBucket.length - 1]);
  assert.equal(s.closed[3].high, Math.max(...inBucket));
  assert.equal(s.closed[3].low, Math.min(...inBucket));
  assert.equal(s.forming.time, T0 + 45);
  assert.equal(feed.status().chartAsset, 'EURUSD_otc');
  assert.equal(feed.status().chartPeriod, 15);
});

test('las velas se arman de la duración que haga falta, esté como esté la gráfica de la terminal', () => {
  const feed = createFeed();
  const now = 1_000_000;
  // La terminal está en modo línea (period 1): solo manda precios.
  const ticks = [];
  for (let t = T0; t < T0 + 120; t += 0.5) ticks.push([t, 1.2 + Math.floor((t - T0) / 5) * 0.0001]);
  history(feed, { asset: 'EURUSD_otc', period: 1, history: ticks }, now);
  assert.equal(feed.snapshot({ now, period: 15, asset: '' }).closed.length, 7); // 8 velas de 15 s: 7 cerradas + la en curso
  assert.equal(feed.snapshot({ now, period: 60, asset: '' }).closed.length, 1);
  assert.equal(feed.snapshot({ now, period: 5, asset: '' }).closed.length, 23);
});

test('otro par en la terminal: se avisa cuál es, y al cambiar se sigue el nuevo', () => {
  const feed = createFeed();
  stream(feed, 'AUDCAD_otc', T0 + 1, 1.04762, 1000);
  feed.onFrame('451-["updateAssets",{"_placeholder":true,"num":0}]', { now: 1000 });
  feed.onFrame(b64([[67, 'AUDCAD_otc', 'AUD/CAD OTC', 'currency', 5, 92, 60, 30, 3, 1], [66, 'EURUSD_otc', 'EUR/USD OTC', 'currency', 5, 50, 60, 30, 3, 1]]), { binary: true, now: 1000 });
  feed.onFrame('42["changeSymbol",{"asset":"AUDCAD_otc","period":15}]', { sent: true, now: 1000 });
  const wrong = feed.snapshot({ now: 1000, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.wrongAsset, true);
  assert.match(wrong.reason, /otro par \(AUD\/CAD OTC\)/);
  // La terminal dice estar en el par pedido pero sus precios aún no llegan: no es "otro par".
  const early = createFeed();
  early.onFrame('42["changeSymbol",{"asset":"EURUSD_otc","period":15}]', { sent: true, now: 1000 });
  const waiting = early.snapshot({ now: 1000, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(waiting.ok, false);
  assert.equal(waiting.wrongAsset, false);
  assert.match(waiting.reason, /no tiene precios todavía/);
  // Sin par configurado se toma el que muestre la terminal, con su pago base.
  const any = feed.snapshot({ now: 1000, period: 15, asset: '' });
  assert.equal(any.asset, 'AUDCAD_otc');
  assert.equal(any.payout, 92);
  // La terminal cambia a EUR/USD OTC y empiezan a llegar sus precios.
  feed.onFrame('42["changeSymbol",{"asset":"EURUSD_otc","period":15}]', { sent: true, now: 2000 });
  stream(feed, 'EURUSD_otc', T0 + 2, 1.11904, 2000);
  const right = feed.snapshot({ now: 2000, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(right.ok, true);
  assert.equal(right.label, 'EUR/USD OTC');
  assert.equal(right.payout, 50);
  assert.equal(right.price, 1.11904);
  // Cómo llama la terminal a cada par (para pedirle el correcto).
  assert.equal(feed.symbolFor('EUR/USD OTC'), 'EURUSD_otc');
  assert.equal(feed.symbolFor('aud/cad otc'), 'AUDCAD_otc');
  assert.equal(feed.symbolFor('GBP/JPY OTC'), null);
  assert.equal(feed.symbolFor(''), null);
  // Si la terminal vuelve a otro par y del nuestro dejan de llegar precios, se dice "otro par".
  feed.onFrame('42["changeSymbol",{"asset":"AUDCAD_otc","period":15}]', { sent: true, now: 3000 });
  const gone = feed.snapshot({ now: 2000 + STALE_MS + 1500, period: 15, asset: 'EUR/USD OTC' });
  assert.equal(gone.ok, false);
  assert.equal(gone.wrongAsset, true);
});

test('mensajes que no se entienden se ignoran sin romper nada', () => {
  const feed = createFeed();
  feed.onFrame('2', { now: 1 });
  feed.onFrame('42["otraCosa",{"x":1}]', { now: 1 });
  feed.onFrame('451-["updateStream",{"_placeholder":true,"num":0}]', { now: 1 });
  feed.onFrame(Buffer.from('esto no es json').toString('base64'), { binary: true, now: 1 });
  feed.onFrame(b64([['EURUSD_otc', 'x', null]]), { binary: true, now: 1 }); // binario sin evento pendiente
  assert.equal(feed.snapshot({ now: 1, period: 15 }).ok, false);
  assert.equal(feed.status().frames, 5);
});

// ---------- Puente precio -> pantalla ----------
// Mercado inventado en precios y la misma gráfica "leída de la pantalla": 40 px por pip, con redondeo.
function market(n, seed = 7) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  let price = 1.12;
  const out = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + Math.round((rnd() - 0.5) * 30) * 0.00001;
    const high = Math.max(open, close) + Math.round(rnd() * 8) * 0.00001;
    const low = Math.min(open, close) - Math.round(rnd() * 8) * 0.00001;
    out.push({ time: T0 + i * 15, open, close, high, low });
    price = close;
  }
  return out;
}
const A = -224000;
const B = 200000; // 2 px por cada 0.00001
const onScreen = (c, i) => ({
  x0: i * 24,
  x1: i * 24 + 14,
  dir: c.close >= c.open ? 'up' : 'down',
  open: Math.round(A + B * c.open),
  close: Math.round(A + B * c.close),
  high: Math.round(A + B * c.high),
  low: Math.round(A + B * c.low),
});

test('el ajuste recupera la recta precio -> pantalla y dice que cuadra', () => {
  const candles = market(21);
  const feed = { closed: candles.slice(0, 20), forming: candles[20] };
  const pixel = candles.map(onScreen);
  const fit = fitPriceMap(pixel, feed);
  assert.equal(fit.valid, true);
  assert.equal(fit.shift, 0);
  assert.ok(Math.abs(fit.B - B) / B < 0.01, `B ${fit.B}`);
  assert.ok(fit.rms < 1, `error ${fit.rms}`);
  // Una vela de la fuente pasada a pantalla cae donde está dibujada (a menos de 1 px).
  const drawn = toScreen(fit, candles[10], { x0: 240, x1: 254 });
  assert.ok(Math.abs(drawn.high - pixel[10].high) < 1);
  assert.equal(drawn.x0, 240);
  assert.equal(drawn.dir, pixel[10].dir);
});

test('si la pantalla va una vela atrasada o adelantada, se alinea sola', () => {
  const candles = market(22);
  const pixel = candles.slice(0, 21).map(onScreen); // la pantalla aún no dibuja la última vela
  const ahead = fitPriceMap(pixel, { closed: candles.slice(0, 21), forming: candles[21] });
  assert.equal(ahead.valid, true);
  assert.equal(ahead.shift, 1); // la fuente ya cerró una vela más
  const behind = fitPriceMap(candles.map(onScreen), { closed: candles.slice(0, 20), forming: candles[20] });
  assert.equal(behind.valid, true);
  assert.equal(behind.shift, -1); // la pantalla ya cerró una que la fuente no
});

test('otra gráfica (otro par u otra temporalidad) NO cuadra: la fuente interna no se usa', () => {
  const pixel = market(21, 7).map(onScreen);
  const other = market(21, 99);
  const fit = fitPriceMap(pixel, { closed: other.slice(0, 20), forming: other[20] });
  assert.equal(fit.valid, false);
  assert.ok(fit.rms > fit.tolerance);
  // Con muy pocas velas en común no se da por bueno.
  assert.equal(fitPriceMap(pixel.slice(0, 4), { closed: market(21, 7).slice(0, 3), forming: null }), null);
});
