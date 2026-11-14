/**
 * Prueba de punta a punta del panel (main.js) SIN abrir ventana ni tocar la pantalla.
 *
 * Electron se sustituye por un doble: la "pantalla" es una gráfica de velas dibujada aquí,
 * lectura a lectura, con un mercado inventado de velas de 15 s; el reloj también es de mentira,
 * así cada lectura cae a una hora exacta. Lo que se comprueba es lo que el panel publica:
 *
 *   - el marcador está siempre sobre la vela en curso y cambia de vela en la misma lectura;
 *   - el reloj de la vela (lo que lleva y lo que le falta);
 *   - soporte y resistencia con sus toques y su estado;
 *   - PREDECIR analiza y predice al momento (sin esperar a la vela siguiente); la señal vale
 *     hasta el cierre de la vela y se califica ahí, contra el precio de la señal;
 *   - si la vela en curso no está a la vista, el marcador se oculta y se avisa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ---------- Reloj de mentira ----------
let nowMs = 1_800_000_000_000;
Date.now = () => nowMs;

// ---------- Mercado inventado: velas de 15 s, una lectura cada 300 ms ----------
const W = 640;
const H = 400;
const CANDLE_MS = 15000;
const READ_MS = 300;
const VISIBLE = 24; // velas cerradas a la vista
const PX = 4; // píxeles por unidad de precio
const BG = [22, 26, 40];
const GREEN = [60, 200, 80];
const RED = [240, 70, 60];
const LINE = [205, 208, 215];

let seed = 12345;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const market = { closed: [], forming: null, price: 0, startedAt: 0 };
function openCandle(at) {
  market.forming = { open: market.price, high: market.price, low: market.price, close: market.price };
  market.startedAt = at;
}
/** Avanza el mercado hasta `at` (una lectura). Devuelve true si en este paso cerró una vela. */
function advance(at) {
  let closedNow = false;
  if (at - market.startedAt >= CANDLE_MS) {
    market.closed.push(market.forming);
    openCandle(market.startedAt + CANDLE_MS);
    closedNow = true;
  }
  // Paseo al azar en pasos de 1 px, con un poco de regreso al centro para no salirse de la zona.
  const step = Math.round((random() - 0.5 - market.price * 0.004) * 6) / PX;
  market.price += step;
  const f = market.forming;
  f.close = market.price;
  f.high = Math.max(f.high, market.price);
  f.low = Math.min(f.low, market.price);
  return closedNow;
}

const rowOf = (price) => Math.round(H / 2 - price * PX);
const xOf = (index) => 20 + index * 24;
/** Dibuja la gráfica: línea del precio y velas (cerradas + la vela en curso al final). */
function draw({ withForming = true, linePrice = market.price, blank = false } = {}) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = BG[0];
    rgba[p + 1] = BG[1];
    rgba[p + 2] = BG[2];
    rgba[p + 3] = 255;
  }
  if (blank) return rgba;
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const p = (y * W + x) * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
  };
  for (let x = 0; x < W; x++) paint(x, rowOf(linePrice), LINE);
  const list = [...market.closed.slice(-VISIBLE), ...(withForming ? [market.forming] : [])];
  list.forEach((c, i) => {
    const color = c.close >= c.open ? GREEN : RED;
    const x0 = xOf(i);
    for (let y = rowOf(c.high); y <= rowOf(c.low); y++) for (const x of [x0 + 7, x0 + 8]) paint(x, y, color);
    for (let y = rowOf(Math.max(c.open, c.close)); y <= rowOf(Math.min(c.open, c.close)); y++) {
      for (let x = x0; x < x0 + 15; x++) paint(x, y, color);
    }
  });
  return rgba;
}
/** Columna (en puntos de la zona) donde el panel debe marcar la vela en curso. */
const formingX = () => 2 + xOf(Math.min(market.closed.length, VISIBLE));

// ---------- Doble de Electron ----------
let frame = draw({ blank: true });
const sent = [];
const handlers = {};
const intervals = [];
const fakeImage = () => ({
  crop: () => fakeImage(),
  getSize: () => ({ width: W, height: H }),
  toBitmap: () => {
    const bgra = Buffer.from(frame);
    for (let p = 0; p < bgra.length; p += 4) {
      const red = bgra[p];
      bgra[p] = bgra[p + 2];
      bgra[p + 2] = red;
    }
    return bgra;
  },
  toPNG: () => Buffer.alloc(8),
});
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lector-flujo-'));
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ pauseSeconds: 3, cycleSeconds: 5, manual: true, alwaysSignal: true, untilClose: true }));
class FakeWindow {
  constructor() {
    this.webContents = { send: (_channel, state) => sent.push(state) };
  }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setContentProtection(on) {
    FakeWindow.protected = on;
  }
  loadFile() {}
  on() {}
  isDestroyed() {
    return false;
  }
}
const electron = {
  app: { getPath: () => userData, whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => true, on: () => {}, quit: () => {} },
  BrowserWindow: FakeWindow,
  ipcMain: { on: (name, fn) => (handlers[name] = fn) },
  screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: W, height: H }, scaleFactor: 1, bounds: { x: 0, y: 0, width: W, height: H } }) },
  shell: { openExternal: () => {} },
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
  desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: fakeImage() }] },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electron;
  return realLoad.call(this, request, ...rest);
};
// El panel programa sus lecturas con setInterval / setTimeout: aquí las lecturas se dan a mano.
global.setInterval = (fn, ms) => {
  intervals.push({ fn, ms });
  return 0;
};
global.setTimeout = () => 0;

require('../main.js');

const scanTick = () => intervals.find((i) => i.ms === 300).fn();
const flush = () => intervals.filter((i) => i.ms === 5000).forEach((i) => i.fn());
const state = () => sent[sent.length - 1];
/** Una lectura: avanza el reloj y el mercado, dibuja y deja que el panel lea. */
async function read(options = {}) {
  nowMs += READ_MS;
  const closedNow = options.frozen ? false : advance(nowMs);
  frame = draw(options);
  await scanTick();
  return { s: state(), closedNow };
}
const elapsed = () => nowMs - market.startedAt;
/** Lee hasta que la vela en curso lleve `ms` abierta (por defecto, hasta que abra una nueva). */
async function readUntilElapsed(ms) {
  let last = null;
  do last = await read();
  while (!(elapsed() >= ms && elapsed() < ms + READ_MS));
  return last.s;
}
const records = () => {
  flush();
  const dir = path.join(userData, 'registro');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('') : '';
};

test('arranca, lee la gráfica y pone el reloj de la vela en hora', async () => {
  await Promise.resolve(); // app.whenReady()
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(handlers.predict, 'el panel registró sus mensajes');
  // Mercado con 14 velas ya cerradas antes de empezar a mirar.
  openCandle(nowMs);
  for (let i = 0; i < 14 * (CANDLE_MS / READ_MS); i++) {
    nowMs += READ_MS;
    advance(nowMs);
  }
  handlers['set-region'](null, { x: 0, y: 0, width: W, height: H });

  // Cinco velas completas: el panel ve cerrar varias y mide que duran 15 s.
  let closes = 0;
  for (let i = 0; i < 5 * (CANDLE_MS / READ_MS) + 4; i++) {
    const { s, closedNow } = await read();
    if (closedNow) closes++;
    assert.equal(s.phase, 'idle');
    // El marcador va SIEMPRE sobre la vela en curso, también en la misma lectura en que cierra una.
    if (i >= 3) {
      assert.ok(s.scan && s.scan.current, `lectura ${i}: hay marcador`);
      assert.equal(s.scan.mode, 'follow');
      assert.equal(s.scan.current.x, formingX(), `lectura ${i}: el marcador está en la vela en curso`);
      assert.equal(s.scan.missing, false);
    }
  }
  assert.ok(closes >= 5);
  const s = state();
  assert.match(s.status, /^Leyendo \d+ velas$/);
  assert.equal(s.clockKnown, true);
  assert.equal(s.candleSeconds, 15);
  // Reloj de la vela: lo que lleva y lo que le falta suman su duración (con el retraso de una lectura).
  const c = s.scan.current;
  assert.ok(Math.abs(c.elapsed - elapsed() / 1000) <= 0.7, `lleva ${c.elapsed} s; de verdad ${elapsed() / 1000}`);
  assert.ok(Math.abs(c.elapsed + c.remaining - 15) < 0.11);
  assert.equal(FakeWindow.protected, true); // con trazos sobre la gráfica, la ventana no sale en las capturas
});

test('soporte y resistencia: se publican con toques y estado, dentro de la zona', async () => {
  const { scan } = state();
  const found = [scan.support, scan.resistance].filter(Boolean);
  assert.ok(found.length >= 1, 'con 19 velas de un mercado que sube y baja hay al menos un nivel');
  for (const level of found) {
    assert.ok(level.row > 0 && level.row < H);
    assert.ok(level.touches >= 1);
    assert.equal(typeof level.flipped, 'boolean');
  }
  const priceRow = scan.current.price;
  if (scan.support) assert.ok(scan.support.row > priceRow, 'el soporte queda por debajo del precio');
  if (scan.resistance) assert.ok(scan.resistance.row < priceRow, 'la resistencia queda por encima del precio');
});

test('PREDECIR con la vela avanzada: sin espera, analiza al momento y califica al cierre de la vela', async () => {
  await readUntilElapsed(9000); // la vela en curso lleva 9 s de 15
  assert.equal(state().ready, true);
  handlers.predict();
  await Promise.resolve();
  let step = await read();
  // El panel está configurado para NO esperar a la vela siguiente (WAIT_FOR_NEXT_CANDLE = false).
  assert.equal(step.s.phase, 'analysis');
  assert.equal(step.s.ready, false);
  const analysisAt = nowMs;
  const candleStart = market.startedAt;

  // Termina el análisis (3 s): sale la señal, que vale hasta el cierre de la vela en curso.
  for (;;) {
    step = await read();
    if (step.s.phase !== 'analysis') break;
    handlers.predict(); // pulsar otra vez no encima nada
  }
  assert.equal(step.s.phase, 'signal');
  assert.ok(nowMs - analysisAt >= 2700 && nowMs - analysisAt <= 3600);
  assert.equal(market.startedAt, candleStart, 'la señal salió dentro de la misma vela (a los ~12 s de 15)');
  assert.equal(step.s.untilClose, true);
  assert.ok(['up', 'down'].includes(step.s.signal.dir));
  const dir = step.s.signal.dir;
  const signalPrice = market.price;
  assert.ok(Math.abs(step.s.remainingMs - (CANDLE_MS - elapsed())) <= 700);

  // Zona de entrada: dos líneas, con el precio de la señal dentro; la línea de referencia es ese precio.
  const plan = step.s.scan.entry;
  assert.ok(plan && plan.suggested && plan.zone, 'la señal trae su zona de entrada');
  assert.equal(plan.taken, true);
  assert.match(plan.kind, /^(orilla alta|orilla baja)$/);
  const entryRow = plan.row - 2; // de puntos de la zona a filas de la imagen
  assert.equal(entryRow, rowOf(signalPrice));
  // Venta: el mejor precio es la línea de arriba (fila menor); compra: la de abajo.
  if (dir === 'down') assert.ok(plan.zone.best < plan.row && plan.row < plan.zone.limit);
  else assert.ok(plan.zone.limit < plan.row && plan.row < plan.zone.best);
  assert.equal(plan.zone.inside, true);
  assert.deepEqual(step.s.entry, { kind: plan.kind, filled: true, zone: true, inZone: true });

  // No se califica a los 5 s de antes: se espera al cierre de la vela.
  let lastOfCandle = market.price;
  let taken = true; // con zona, la entrada de referencia es la del momento de la señal
  for (;;) {
    step = await read();
    if (step.closedNow) break;
    lastOfCandle = market.price;
    assert.equal(step.s.phase, 'signal', `a los ${elapsed() / 1000} s de la vela sigue la señal`);
    if (step.s.scan.entry && step.s.scan.entry.taken) taken = true; // el precio llegó a la línea
  }
  assert.equal(step.s.phase, 'idle');
  const closePrice = market.closed[market.closed.length - 1].close;
  assert.equal(closePrice, lastOfCandle);
  // Si el precio no llegó a la línea no hubo entrada; si llegó, se mide el cierre contra la ENTRADA.
  const gap = entryRow - rowOf(closePrice); // positivo = la vela cerró por encima de la entrada
  const move = Math.abs(gap) < 0.5 ? 'flat' : gap > 0 ? 'up' : 'down';
  const expected = !taken ? 'sin entrada' : move === 'flat' ? 'empate' : move === dir ? 'acertó' : 'falló';
  assert.ok(step.s.lastResult.startsWith(expected), `señal ${dir} en ${signalPrice}, entrada ${taken ? 'tomada' : 'no tomada'}, cierre ${closePrice}: ${step.s.lastResult}`);

  const log = records();
  assert.doesNotMatch(log, /espera-vela/); // nunca se quedó esperando la vela siguiente
  assert.match(log, /\nE,\d+,analisis,/);
  assert.match(log, /\nS,\d+,(up|down),reglas,\w+,5,[^,]*,cierre:\d/);
  assert.match(log, new RegExp(`\\nR,\\d+,${expected}`));
  assert.ok(/E,[0-9]+,zona-entrada,(orilla alta|orilla baja)/.test(log));
});

test('PREDECIR con la vela recién abierta: analiza y predice esa vela de inmediato', async () => {
  await readUntilElapsed(1800); // lleva 1.8 s de 15 (límite: 5 s)
  handlers.predict();
  await Promise.resolve();
  let { s } = await read();
  assert.equal(s.phase, 'analysis');
  const candleStart = market.startedAt;
  let step = null;
  do step = await read();
  while (step.s.phase === 'analysis');
  assert.equal(step.s.phase, 'signal');
  assert.equal(step.s.untilClose, true);
  assert.equal(market.startedAt, candleStart, 'la señal salió dentro de la misma vela');
  do step = await read();
  while (!step.closedNow);
  assert.equal(step.s.phase, 'idle');
  assert.match(step.s.lastResult, /^(acertó|falló|empate|sin entrada)/);
});

test('si la vela en curso no está a la vista, el marcador se oculta y se avisa', async () => {
  // Gráfica movida hacia atrás: la última vela que se ve es una ya cerrada y la línea del precio va por otro lado.
  const away = { withForming: false, linePrice: market.closed[market.closed.length - 1].close + 12, frozen: true };
  let { s } = await read(away);
  assert.equal(s.scan.current, null, 'no se marca una vela vieja');
  ({ s } = await read(away));
  assert.equal(s.scan.current, null);
  assert.equal(s.scan.missing, true);
  assert.match(s.status, /^La vela actual no está a la vista/);
  // Vuelve a verse: el marcador regresa en la primera lectura.
  ({ s } = await read());
  assert.ok(s.scan.current);
  assert.equal(s.scan.missing, false);
  assert.equal(s.scan.current.x, formingX());
});

test('el panel nunca se queda "esperando la siguiente vela" (se quitó la espera)', async () => {
  // La espera (y su cancelación a los 90 s sin precio) sigue probada en test/alineado.test.js, por si
  // se vuelve a activar con WAIT_FOR_NEXT_CANDLE = true en main.js.
  assert.ok(sent.every((s) => !s || s.phase !== 'waiting'));
  assert.doesNotMatch(records(), /espera-vela|cancelada/);
});

test.after(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});
