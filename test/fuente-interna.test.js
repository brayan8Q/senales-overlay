/**
 * Prueba de punta a punta de la FUENTE INTERNA (main.js), sin abrir ventanas ni red.
 *
 * Electron se sustituye por un doble, igual que en flujo.test.js: la "pantalla" es una gráfica de
 * velas dibujada aquí y el reloj es de mentira. Además hay una "terminal demo" de mentira: el
 * mismo mercado llega como mensajes de websocket con la forma real de Pocket Option (por el
 * depurador de la ventana de la fuente interna). Lo que se comprueba:
 *
 *   - sin datos internos el panel lee los píxeles y lo dice;
 *   - cuando llegan y cuadran con la gráfica, la fuente activa pasa a INTERNA: precio exacto,
 *     reloj de la vela exacto, y las velas dibujadas donde están en la pantalla;
 *   - el pago real (el de la terminal) queda en el registro de cada operación, con su patrón;
 *   - con la gráfica tapada el panel sigue dando y calificando señales con la fuente interna;
 *   - si la fuente interna deja de actualizar más de 5 s, vuelve sola a los píxeles y avisa;
 *   - si lo que llega no cuadra con la gráfica de la pantalla, no se usa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ---------- Reloj de mentira ----------
let nowMs = 1_800_000_000_000; // múltiplo de 15 s: ahí abre una vela
Date.now = () => nowMs;

// ---------- Mercado inventado: velas de 15 s, una lectura cada 300 ms ----------
const W = 640;
const H = 400;
const CANDLE_MS = 15000;
const READ_MS = 300;
const VISIBLE = 24;
const PX = 4; // píxeles por unidad de precio
const BG = [22, 26, 40];
const GREEN = [60, 200, 80];
const RED = [240, 70, 60];
const LINE = [205, 208, 215];
// Precio real de una unidad del mercado: 1 px de la pantalla = 0.00001.
const realPrice = (units) => Number((1.12 + units * 0.00004).toFixed(5));

let seed = 4242;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const market = { closed: [], forming: null, price: 0, startedAt: nowMs, ticks: [] };
/** Avanza el mercado hasta `at`. Cada vela abre en su primer precio, como en la plataforma. */
function advance(at) {
  let closedNow = false;
  if (market.forming && at - market.startedAt >= CANDLE_MS) {
    market.closed.push(market.forming);
    market.forming = null;
    market.startedAt += CANDLE_MS;
    closedNow = true;
  }
  market.price += Math.round((random() - 0.5 - market.price * 0.004) * 6) / PX;
  const p = market.price;
  if (!market.forming) market.forming = { open: p, high: p, low: p, close: p };
  else {
    market.forming.close = p;
    market.forming.high = Math.max(market.forming.high, p);
    market.forming.low = Math.min(market.forming.low, p);
  }
  market.ticks.push([at / 1000, realPrice(p)]);
  return closedNow;
}

const rowOf = (price) => Math.round(H / 2 - price * PX);
const xOf = (index) => 20 + index * 24;
function draw({ blank = false, mirror = false, blob = false, mark = false, text = false } = {}) {
  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = BG[0];
    rgba[p + 1] = BG[1];
    rgba[p + 2] = BG[2];
    rgba[p + 3] = 255;
  }
  if (blank) return rgba;
  const m = mirror ? -1 : 1; // "otra gráfica": la misma, pero al revés
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const p = (y * W + x) * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
  };
  for (let x = 0; x < W; x++) paint(x, rowOf(m * market.price), LINE);
  const list = [...market.closed.slice(-VISIBLE), market.forming];
  list.forEach((c, i) => {
    const up = mirror ? c.close <= c.open : c.close >= c.open;
    const color = up ? GREEN : RED;
    const x0 = xOf(i);
    const top = Math.min(rowOf(m * c.high), rowOf(m * c.low));
    const bottom = Math.max(rowOf(m * c.high), rowOf(m * c.low));
    for (let y = top; y <= bottom; y++) for (const x of [x0 + 7, x0 + 8]) paint(x, y, color);
    const bodyTop = Math.min(rowOf(m * c.open), rowOf(m * c.close));
    const bodyBottom = Math.max(rowOf(m * c.open), rowOf(m * c.close));
    for (let y = bodyTop; y <= bodyBottom; y++) for (let x = x0; x < x0 + 15; x++) paint(x, y, color);
    // Marca de una operación abierta: un bloque blanco chico bajo el precio, junto a la vela en curso.
    if (mark && i === list.length - 1) {
      const y0 = rowOf(m * market.price) + 14;
      for (let y = y0; y < y0 + 9; y++) for (let x = x0 + 16; x < x0 + 22; x++) paint(x, y, [255, 255, 255]);
    }
    // Letras blancas que ya estaban ahí (como las del globo de la operación anterior), sobre el precio.
    if (text && i === list.length - 1) {
      const y0 = rowOf(m * market.price) - 22;
      for (let y = y0; y < y0 + 8; y++) for (let x = x0 + 16; x < x0 + 24; x++) paint(x, y, [255, 255, 255]);
    }
    // "Globo" de la plataforma: alarga hacia arriba el cuerpo de una vela cerrada (la deforma).
    if (blob && i === list.length - 4) for (let y = bodyTop - 14; y < bodyTop; y++) for (let x = x0; x < x0 + 15; x++) paint(x, y, color);
  });
  return rgba;
}

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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lector-fuente-'));
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ pauseSeconds: 0, cycleSeconds: 3, manual: true, alwaysSignal: true, asset: 'EUR/USD OTC', payout: 92, antiRebound: false, patternVeto: false, martinLevels: 0, entryWaitSeconds: 0 }),
);
// La ventana de la fuente interna: su depurador entrega aquí los mensajes del websocket.
const terminal = { listener: null, url: null, visible: false, pay: 'Payout\n+58%\n+$15.80', sym: 'EUR/USD OTC', scripts: [] };
class FakeWindow {
  constructor(options = {}) {
    this.isVisor = /^Fuente interna/.test(options.title || '');
    this.webContents = {
      send: (_channel, state) => sent.push(state),
      setWindowOpenHandler: () => {},
      on: () => {},
      executeJavaScript: async (code) => {
        terminal.scripts.push(code);
        return { pay: terminal.pay, sym: terminal.sym };
      },
      debugger: {
        attach: () => {},
        on: (name, fn) => {
          if (name === 'message') terminal.listener = fn;
        },
        sendCommand: async () => ({}),
      },
    };
  }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setContentProtection() {}
  loadFile() {}
  loadURL(url) {
    terminal.url = url;
  }
  on() {}
  hide() {
    terminal.visible = false;
  }
  show() {
    terminal.visible = true;
  }
  focus() {}
  isVisible() {
    return terminal.visible;
  }
  destroy() {}
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
global.setInterval = (fn, ms) => {
  intervals.push({ fn, ms });
  return 0;
};
global.setTimeout = () => 0;

require('../main.js');

// ---------- La terminal demo de mentira ----------
const SOCKET = { requestId: 'ws1', url: 'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket' };
const emit = (method, params) => terminal.listener(null, method, params);
const received = (payloadData, opcode = 1) => emit('Network.webSocketFrameReceived', { requestId: SOCKET.requestId, response: { opcode, payloadData } });
const binary = (value) => received(Buffer.from(JSON.stringify(value)).toString('base64'), 2);
let feedOn = false;
function sendTick() {
  const [time, price] = market.ticks[market.ticks.length - 1];
  received('451-["updateStream",{"_placeholder":true,"num":0}]');
  binary([['EURUSD_otc', time, price]]);
}
function sendHistory() {
  received('451-["updateHistoryNewFast",{"_placeholder":true,"num":0}]');
  binary({ asset: 'EURUSD_otc', period: 15, history: market.ticks.slice(-2500), candles: [] });
}

const scanTick = () => intervals.find((i) => i.ms === 300).fn();
const readPayout = () => intervals.find((i) => i.ms === 3000).fn();
const flush = () => intervals.filter((i) => i.ms === 5000).forEach((i) => i.fn());
const state = () => sent[sent.length - 1];
async function read(options = {}) {
  nowMs += READ_MS;
  const closedNow = advance(nowMs);
  if (feedOn) sendTick();
  frame = draw(options);
  await scanTick();
  return { s: state(), closedNow };
}
const records = () => {
  flush();
  const dir = path.join(userData, 'registro');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('') : '';
};
const feedPrice = () => market.ticks[market.ticks.length - 1][1];

test('sin datos internos: lee los píxeles y lo dice', async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminal.url, 'https://pocketoption.com/en/cabinet/try-demo/'); // se abrió la terminal DEMO, oculta
  assert.equal(terminal.visible, false);
  assert.ok(terminal.listener, 'el panel escucha el websocket de la terminal');
  // 14 velas ya cerradas antes de empezar a mirar.
  for (let i = 0; i < 14 * (CANDLE_MS / READ_MS); i++) {
    nowMs += READ_MS;
    advance(nowMs);
  }
  handlers['set-region'](null, { x: 0, y: 0, width: W, height: H });
  let s = null;
  for (let i = 0; i < 12; i++) ({ s } = await read());
  assert.equal(s.source.active, 'PÍXELES');
  assert.equal(s.source.code, 'sin-datos');
  assert.equal(s.source.warn, true);
  assert.equal(s.internalSource, true);
  assert.match(s.status, /^Leyendo \d+ velas$/);
  assert.deepEqual(s.payoutNow, { value: 92, source: 'config' });
});

test('llegan los datos y cuadran con la gráfica: fuente INTERNA, precio y reloj exactos', async () => {
  emit('Network.webSocketCreated', SOCKET);
  emit('Network.webSocketFrameSent', { requestId: SOCKET.requestId, response: { opcode: 1, payloadData: '42["changeSymbol",{"asset":"EURUSD_otc","period":15}]' } });
  sendHistory();
  feedOn = true;
  let s = null;
  for (let i = 0; i < 8; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA', s.source.detail);
  assert.equal(s.source.code, 'ok');
  assert.equal(s.source.warn, false);
  assert.equal(s.source.ageSeconds, 0);
  assert.match(s.source.detail, /velas de 15 s/);
  // El precio es el de la fuente, con todos sus decimales.
  assert.equal(s.price, feedPrice().toFixed(5));
  // Reloj de la vela: exacto, por la hora del servidor.
  assert.equal(s.clockKnown, true);
  assert.equal(s.candleSeconds, 15);
  const elapsed = (nowMs - market.startedAt) / 1000;
  assert.ok(Math.abs(s.scan.current.elapsed - elapsed) < 0.11, `lleva ${s.scan.current.elapsed}; de verdad ${elapsed}`);
  // Las velas (con números de la fuente) quedan dibujadas donde están en la pantalla.
  const drawn = [...market.closed.slice(-VISIBLE), market.forming];
  assert.equal(s.scan.candles.length, drawn.length);
  s.scan.candles.forEach((box, i) => {
    assert.equal(box.x, 2 + xOf(i), `vela ${i}: columna`);
    assert.ok(Math.abs(box.y - (2 + rowOf(drawn[i].high))) <= 1.01, `vela ${i}: alto ${box.y} vs ${2 + rowOf(drawn[i].high)}`);
  });
  assert.match(records(), /\nF,\d+,INTERNA,ok,/);
  assert.match(records(), /\nT,\d+,1\.\d{5},0\.0001,i\n/); // el precio registrado viene de la fuente interna
});

test('el pago real sale de la terminal y queda en el registro de la operación, con su patrón', async () => {
  await readPayout();
  let { s } = await read();
  assert.deepEqual(s.payoutNow, { value: 58, source: 'interna' });
  handlers.predict();
  await Promise.resolve();
  let step = null;
  do step = await read();
  while (step.s.phase !== 'signal');
  const dir = step.s.signal.dir;
  assert.ok(['up', 'down'].includes(dir));
  assert.ok(step.s.pattern && step.s.pattern.key, 'la señal trae su patrón');
  const p0 = Number(step.s.price);
  do step = await read();
  while (step.s.phase === 'signal');
  const p1 = Number(step.s.price);
  const expected = p1 === p0 ? 'empate' : p1 > p0 === (dir === 'up') ? 'acertó' : 'falló';
  assert.equal(step.s.lastResult, expected, `señal ${dir} en ${p0}, terminó en ${p1}`);
  const key = expected === 'acertó' ? 'win' : expected === 'falló' ? 'loss' : 'tie';
  const log = records();
  assert.match(log, new RegExp(`\\nS,\\d+,${dir},reglas,\\w+,3,[^,]*,,${step.s.patterns[0].pattern},\\n`));
  assert.match(log, new RegExp(`\\nP,\\d+,\\w+,${dir},${key},58,interna,3,op\\n`));
  assert.match(log, /\nK,\d+,15,1\.\d{5}\/1\.\d{5}\/1\.\d{5}\/1\.\d{5};/); // las velas exactas de la señal
  // La estadística por patrón ya cuenta esa operación, con el pago real.
  assert.equal(step.s.patterns.length, 1);
  assert.equal(step.s.patterns[0].n, 1);
  assert.equal(step.s.patterns[0].avgPayout, 58);
  // Si la terminal muestra otro par, su pago no se usa.
  terminal.sym = 'AUD/CAD OTC';
  await readPayout();
  ({ s } = await read());
  assert.deepEqual(s.payoutNow, { value: 92, source: 'config' });
  terminal.sym = 'EUR/USD OTC';
  await readPayout();
});

test('con la gráfica tapada el panel sigue dando y calificando señales con la fuente interna', async () => {
  let s = null;
  for (let i = 0; i < 6; i++) ({ s } = await read({ blank: true }));
  assert.equal(s.source.active, 'INTERNA');
  assert.equal(s.status, 'Gráfica tapada: sigo leyendo con la fuente interna');
  assert.equal(s.price, feedPrice().toFixed(5));
  assert.equal(s.ready, true);
  handlers.predict();
  await Promise.resolve();
  let step = null;
  do step = await read({ blank: true });
  while (step.s.phase !== 'signal');
  const dir = step.s.signal.dir;
  const p0 = Number(step.s.price);
  do step = await read({ blank: true });
  while (step.s.phase === 'signal');
  const p1 = Number(step.s.price);
  const expected = p1 === p0 ? 'empate' : p1 > p0 === (dir === 'up') ? 'acertó' : 'falló';
  assert.equal(step.s.lastResult, expected);
  assert.equal(step.s.source.active, 'INTERNA');
  // Se destapa: todo sigue en su sitio.
  for (let i = 0; i < 6; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA');
  assert.match(s.status, /^Leyendo \d+ velas$/);
});

test('una vela deformada un momento (el globo de la operación) no suelta la fuente interna', async () => {
  let s = null;
  const before = records().split('\nF,').length;
  for (let i = 0; i < 12; i++) {
    ({ s } = await read({ blob: true }));
    assert.equal(s.source.active, 'INTERNA', `lectura ${i}: ${s.source.detail}`);
  }
  for (let i = 0; i < 4; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA');
  assert.equal(records().split('\nF,').length, before, 'la fuente no cambió ni una vez');
});

test('si la fuente interna deja de actualizar más de 5 s, vuelve sola a los píxeles y avisa', async () => {
  feedOn = false;
  let s = null;
  for (let i = 0; i < 15; i++) ({ s } = await read()); // 4.5 s sin datos: todavía aguanta
  assert.equal(s.source.active, 'INTERNA');
  for (let i = 0; i < 4; i++) ({ s } = await read()); // 5.7 s
  assert.equal(s.source.active, 'PÍXELES');
  assert.equal(s.source.code, 'caida');
  assert.equal(s.source.warn, true);
  assert.match(s.source.detail, /lleva \d+ s sin actualizar/);
  assert.ok(s.source.ageSeconds > 5);
  // El panel sigue funcionando con los píxeles.
  for (let i = 0; i < 10; i++) ({ s } = await read());
  assert.match(s.status, /^Leyendo \d+ velas$/);
  assert.ok(s.scan && s.scan.current, 'el marcador sigue sobre la vela en curso');
  assert.match(records(), /\nF,\d+,PÍXELES,caida,/);
  // Vuelve la conexión (la terminal recarga su historial): otra vez INTERNA.
  sendHistory();
  feedOn = true;
  for (let i = 0; i < 8; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA');
});

test('si lo que llega no cuadra con la gráfica de la pantalla, la fuente interna no se usa', async () => {
  let s = null;
  for (let i = 0; i < 10; i++) ({ s } = await read({ mirror: true })); // en pantalla hay OTRA gráfica
  assert.equal(s.source.active, 'PÍXELES');
  assert.equal(s.source.code, 'no-cuadra');
  assert.match(s.source.detail, /no coincide con la gráfica de la pantalla: si cambiaste de par/);
  // Y al volver a verse la gráfica correcta, se recupera sola.
  for (let i = 0; i < 12; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA');
});

test('seguimiento: cuando una señal pierde, el panel da la martingala en esa misma lectura y la mide aparte', async () => {
  handlers['set-martin'](null, 1);
  let s = null;
  for (let i = 0; i < 6; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA');
  assert.equal(s.martinLevels, 1);
  let martin = null;
  for (let tries = 0; tries < 40 && !martin; tries++) {
    handlers.predict();
    await Promise.resolve();
    let step = null;
    do step = await read();
    while (step.s.phase !== 'signal');
    assert.ok(step.s.follow, 'la señal en curso trae su seguimiento');
    const first = step.s.signal;
    let previous = step.s;
    for (;;) {
      step = await read();
      if (step.s.phase !== 'signal') break;
      if (step.s.signal.source === 'martingala') {
        martin = { state: step.s, lost: first, before: previous };
        break;
      }
      previous = step.s;
    }
    while (step.s.phase === 'signal') step = await read(); // deja terminar lo que esté en curso
  }
  assert.ok(martin, 'en 40 predicciones alguna perdió y dio martingala');
  assert.equal(martin.state.lastResult, 'falló'); // la señal anterior perdió…
  assert.equal(martin.state.signal.martin, 1); // …y en esa misma lectura ya está la martingala
  assert.ok(['up', 'down'].includes(martin.state.signal.dir));
  assert.equal(martin.state.ready, false);
  // Justo antes iba perdiendo y el panel ya avisaba hacia dónde saldría.
  assert.equal(martin.before.follow.state, 'perdiendo');
  assert.ok(martin.before.follow.next && martin.before.follow.next.level === 1);
  const log = records();
  // La señal que perdió queda cerrada con su resultado y su línea P, y enseguida la martingala.
  assert.match(log, new RegExp(`\\nR,\\d+,falló\\nP,\\d+,\\w+,${martin.lost.dir},loss,\\d+,\\w+,3,op\\n`));
  assert.match(log, new RegExp(`\\nS,\\d+,${martin.state.signal.dir},martingala,baja,3,`));
  assert.match(log, new RegExp(`\\nE,\\d+,martingala,1,${martin.state.signal.dir}\\n`));
  assert.match(log, /\nP,\d+,\w+,(up|down),(win|loss|tie),\d+,\w+,3,martin1\n/);
  // Las martingalas se cuentan aparte, no en la estadística por patrón.
  s = state();
  assert.ok(s.martin.wins + s.martin.losses + s.martin.ties >= 1);
  handlers['set-martin'](null, 0);
});

test('dos etapas: la señal espera tu entrada y el plazo cuenta desde que entras', async () => {
  handlers['set-entry-wait'](null, 5);
  let s = null;
  for (let i = 0; i < 4; i++) ({ s } = await read());
  assert.equal(s.entryWaitSeconds, 5);
  // Hasta dar con una señal con lado.
  let step = null;
  for (;;) {
    handlers.predict();
    await Promise.resolve();
    do step = await read();
    while (step.s.phase !== 'signal');
    if (step.s.signal.dir) break;
    while (step.s.phase === 'signal') step = await read();
  }
  const dir = step.s.signal.dir;
  // Etapa 1: espera de entrada. Pasan más de 3 s (el plazo) sin entrar y no se califica nada.
  assert.ok(step.s.entryWait && step.s.entryWait.totalMs === 5000);
  assert.equal(step.s.entered, false);
  assert.equal(step.s.follow, null);
  for (let i = 0; i < 11; i++) {
    step = await read();
    assert.equal(step.s.phase, 'signal');
    assert.ok(step.s.entryWait, `a los ${(i + 1) * 0.3} s sigue esperando la entrada`);
  }
  // El usuario entra: aparece su marca junto a la vela. A la segunda lectura se da por buena.
  step = await read({ mark: true });
  assert.ok(step.s.entryWait, 'una sola lectura con la marca todavía no cuenta');
  step = await read({ mark: true });
  assert.equal(step.s.entryWait, null);
  assert.equal(step.s.entered, true);
  assert.ok(step.s.follow && step.s.follow.state, 'ya hay operación: se dice cómo va');
  assert.ok(step.s.remainingMs <= 3000 && step.s.remainingMs >= 2300, `le quedan ${step.s.remainingMs} ms`);
  // Etapa 2: se mide contra el precio de SU entrada, 3 s después.
  const p0 = Number(step.s.price);
  do step = await read({ mark: true });
  while (step.s.phase === 'signal');
  const p1 = Number(step.s.price);
  const expected = p1 === p0 ? 'empate' : p1 > p0 === (dir === 'up') ? 'acertó' : 'falló';
  assert.equal(step.s.lastResult, expected, `entró en ${p0}, terminó en ${p1}`);
  let log = records();
  assert.match(log, /\nE,\d+,espera-entrada,5\n/);
  assert.match(log, /\nE,\d+,entro,3\.\d\n/); // tardó unos 3.9 s en entrar

  // Con letras blancas ya a la vista (el globo de la operación anterior) no se da una entrada por
  // vista; pero la marca nueva, al lado, sí se nota.
  for (;;) {
    handlers.predict();
    await Promise.resolve();
    do step = await read({ text: true });
    while (step.s.phase !== 'signal');
    if (step.s.signal.dir) break;
    while (step.s.phase === 'signal') step = await read({ text: true });
  }
  for (let i = 0; i < 5; i++) {
    step = await read({ text: true });
    assert.ok(step.s.entryWait, 'las letras que ya estaban no son una entrada');
  }
  step = await read({ text: true, mark: true });
  step = await read({ text: true, mark: true });
  assert.equal(step.s.entered, true, 'la marca nueva se ve aunque haya otras letras blancas al lado');
  do step = await read({ text: true, mark: true });
  while (step.s.phase === 'signal');

  // Si no entra en los 5 s, la señal se suelta sin contar nada.
  for (;;) {
    handlers.predict();
    await Promise.resolve();
    do step = await read();
    while (step.s.phase !== 'signal');
    if (step.s.signal.dir) break;
    while (step.s.phase === 'signal') step = await read();
  }
  const before = state().patterns.reduce((n, p) => n + p.n, 0);
  do step = await read();
  while (step.s.phase === 'signal');
  assert.match(step.s.lastResult, /^sin entrada: no vi tu operación en 5 s/);
  assert.equal(state().patterns.reduce((n, p) => n + p.n, 0), before, 'no se contó ninguna operación');
  assert.match(records(), /\nR,\d+,sin entrada: no vi tu operación en 5 s\n/);
  handlers['set-entry-wait'](null, 0);
});

test('si la terminal está en otro par, el panel la pone sola en el par que se opera', async () => {
  const changeSymbol = (asset) =>
    emit('Network.webSocketFrameSent', { requestId: SOCKET.requestId, response: { opcode: 1, payloadData: `42["changeSymbol",{"asset":"${asset}","period":15}]` } });
  received('451-["updateAssets",{"_placeholder":true,"num":0}]');
  binary([
    [67, 'AUDCAD_otc', 'AUD/CAD OTC', 'currency', 5, 92],
    [66, 'EURUSD_otc', 'EUR/USD OTC', 'currency', 5, 50],
  ]);
  changeSymbol('AUDCAD_otc'); // la terminal abrió en otro par
  terminal.scripts.length = 0;
  await readPayout();
  const change = terminal.scripts.find((code) => code.includes('po-td-asset'));
  assert.ok(change, 'se pidió el cambio de par');
  assert.equal(change, `localStorage.setItem('po-td-asset', "EURUSD_otc"); location.reload();`);
  // No insiste enseguida (un intento cada 20 s, tres como mucho).
  terminal.scripts.length = 0;
  await readPayout();
  assert.equal(terminal.scripts.filter((code) => code.includes('po-td-asset')).length, 0);
  assert.match(records(), /\nF,\d+,visor,cambio-de-par,AUDCAD_otc -> EURUSD_otc\n/);
  // La terminal recarga ya en EUR/USD OTC: pasados los 20 s tampoco se le pide nada más.
  changeSymbol('EURUSD_otc');
  nowMs += 21000;
  terminal.scripts.length = 0;
  await readPayout();
  assert.equal(terminal.scripts.filter((code) => code.includes('po-td-asset')).length, 0);
  nowMs -= 21000;
});

test('el pago de la terminal solo se usa si la fuente interna cuadró con la pantalla hace poco', async () => {
  await readPayout();
  const { s } = await read();
  assert.equal(s.source.active, 'INTERNA');
  assert.deepEqual(s.payoutNow, { value: 58, source: 'interna' });
  // Pasa un minuto sin que la fuente interna vuelva a cuadrar con la pantalla (aquí, porque dejó de
  // dar datos; lo mismo si en la pantalla se cambió de par): aunque la terminal siga mostrando su
  // pago, recién leído, ya no se usa. Vale el que está escrito en el panel.
  nowMs += 61000;
  await readPayout();
  await scanTick();
  assert.notEqual(state().source.active, 'INTERNA');
  assert.deepEqual(state().payoutNow, { value: 92, source: 'config' });
});

test('apagar la fuente interna en ajustes deja todo en píxeles', async () => {
  handlers['set-internal-source'](null, false);
  let s = null;
  for (let i = 0; i < 4; i++) ({ s } = await read());
  assert.equal(s.internalSource, false);
  assert.equal(s.source.active, 'PÍXELES');
  assert.equal(s.source.code, 'apagada');
  assert.equal(s.source.warn, false);
});

test.after(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});
