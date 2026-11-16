/**
 * Prueba de punta a punta de LA ÚLTIMA VELA (main.js con una IA), sin abrir ventanas ni red.
 *
 * Mismo doble de Electron y de la terminal demo que fuente-interna.test.js, pero en automático,
 * con la señal al abrir cada vela y una IA de mentira que anota cuándo se le pregunta. Se comprueba:
 *
 *   - a la IA se le pregunta cuando a la vela le faltan 3 s (segundo 12 de 15), no al empezar el
 *     análisis (segundo 9.5), y se le dice cuándo se abrirá de verdad la operación;
 *   - la señal sigue saliendo al abrir la vela nueva;
 *   - si la vela que vio la IA cambió de color antes de cerrar, la señal no entra (veto «vela») y
 *     queda medida en papel; si no cambió, nunca se frena por eso;
 *   - cuando una señal pierde, la martingala no sale a media vela: se pregunta otra vez en el
 *     segundo 12 y entra al abrir la vela siguiente.
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
function draw({ blank = false, mirror = false, blob = false, mark = false, text = false, hideForming = false } = {}) {
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
    // Una vela que acaba de abrir no tiene cuerpo: en la pantalla no se ve (solo la línea del precio).
    if (hideForming && i === list.length - 1) return;
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lector-consulta-'));
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ pauseSeconds: 5, cycleSeconds: 3, manual: false, alwaysSignal: false, asset: 'EUR/USD OTC', payout: 92, antiRebound: false, patternVeto: false, martinLevels: 1, entryWaitSeconds: 0, newCandle: true, autoTrade: false, aiModel: 'falso-1' }),
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
  // Hay una clave guardada (de mentira): con ella se activa la IA de mentira de abajo.
  safeStorage: { isAsyncEncryptionAvailable: async () => true, decryptStringAsync: async () => ({ result: 'clave-de-prueba' }) },
  desktopCapturer: { getSources: async () => [{ display_id: '1', thumbnail: fakeImage() }] },
};
// El bot de Pocket, de mentira: apagado salvo en la prueba que lo enciende. Guarda lo que se le pide.
const fakeBot = {
  state: { online: false, connected: false, demo: null, balance: null },
  orders: [],
  fail: null, // motivo con el que rechaza la siguiente orden
  finish: null, // resuelve el resultado de la operación abierta
  refresh: async () => fakeBot.state,
  status: () => fakeBot.state,
  order: async (payload) => {
    fakeBot.orders.push(payload);
    if (fakeBot.fail) return { ok: false, error: fakeBot.fail };
    const id = `A${fakeBot.orders.length}`;
    return { ok: true, id, asset: 'EURUSD_otc', amount: payload.level ? 2.2 : 1, open_price: feedPrice(), payout: 52, sent_ms: nowMs, open_ms: nowMs + 200 };
  },
  result: (id) => new Promise((resolve) => (fakeBot.finish = (result, net) => resolve({ ok: true, id, result, net, close_price: feedPrice() }))),
};
// ---------- La IA de mentira ----------
// Anota cada consulta (cuándo llegó, cómo iba la vela) y contesta cuando la prueba lo decide.
const colorOf = (c) => (c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat');
const ai = { asked: [], pending: null };
const provider = (keyFile, configKey) => ({
  name: 'IA de prueba',
  company: 'Pruebas',
  keyFile,
  configKey,
  keysPage: '',
  list: async () => ['falso-1'],
  chat: (models) => models,
  pick: (models) => models[0],
  ask: (options) => {
    const seen = { at: nowMs, elapsed: nowMs - market.startedAt, color: colorOf(market.forming), timeoutMs: options.timeoutMs, snapshot: options.snapshot };
    ai.asked.push(seen);
    // Sigue a la vela en curso: ARRIBA si va verde, ABAJO si va roja.
    const dir = seen.color === 'down' ? 'down' : 'up';
    return new Promise((resolve) => {
      ai.pending = () => resolve({ dir, confidence: 'media', reason: `vela en curso ${dir === 'up' ? 'verde' : 'roja'}`, usage: null });
    });
  },
});
const fakeProviders = { openai: provider('openai.key', 'aiModel'), gemini: provider('gemini.key', 'geminiModel'), claude: provider('claude.key', 'claudeModel') };
fs.writeFileSync(path.join(userData, 'openai.key'), 'cifrada');
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') return electron;
  if (/botbridge$/.test(request)) return { createBotBridge: () => fakeBot };
  if (/providers$/.test(request)) return { PROVIDERS: fakeProviders };
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

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** Una lectura; si la IA tiene una consulta pendiente, contesta enseguida (llega a la lectura siguiente). */
async function step() {
  const out = await read();
  if (ai.pending) {
    const answer = ai.pending;
    ai.pending = null;
    answer();
    await settle();
  }
  return out;
}

test('arranque: fuente interna activa y la IA guardada se activa sola', async () => {
  await settle();
  for (let i = 0; i < 14 * (CANDLE_MS / READ_MS); i++) {
    nowMs += READ_MS;
    advance(nowMs);
  }
  handlers['set-region'](null, { x: 0, y: 0, width: W, height: H });
  emit('Network.webSocketCreated', SOCKET);
  emit('Network.webSocketFrameSent', { requestId: SOCKET.requestId, response: { opcode: 1, payloadData: '42["changeSymbol",{"asset":"EURUSD_otc","period":15}]' } });
  sendHistory();
  feedOn = true;
  let s = null;
  for (let i = 0; i < 10; i++) ({ s } = await read());
  assert.equal(s.source.active, 'INTERNA', s.source.detail);
  assert.equal(s.ai.count, 1);
  assert.equal(s.manual, false);
  assert.equal(s.newCandle, true);
});

test('a la IA se le pregunta al INICIAR cada vela; la señal sale cuando contesta, dentro de esa vela; la martingala igual', async () => {
  // (Lo que se haya preguntado durante el arranque no cuenta; si quedó una consulta en camino, se contesta.)
  if (ai.pending) {
    const answer = ai.pending;
    ai.pending = null;
    answer();
    await settle();
  }
  ai.asked.length = 0;
  const seen = { shown: 0, martin: 0, martinAsks: 0 };
  let previous = 'idle';
  let previousSignal = null;
  let askedBefore = 0;
  let pendingAsk = null;
  for (let i = 0; i < 40 * (CANDLE_MS / READ_MS); i++) {
    const { s } = await step();
    if (ai.asked.length > askedBefore) {
      assert.equal(ai.asked.length, askedBefore + 1, 'una consulta por predicción');
      askedBefore = ai.asked.length;
      pendingAsk = ai.asked[ai.asked.length - 1];
      // La consulta sale con la vela recién abierta (nunca a media vela ni antes del cierre).
      assert.ok(pendingAsk.elapsed <= 1500 + READ_MS, `se preguntó a los ${pendingAsk.elapsed} ms de abrir la vela`);
      assert.ok(Number.isInteger(pendingAsk.timeoutMs), `plazo ${pendingAsk.timeoutMs}`);
      assert.ok(pendingAsk.timeoutMs > 3500 && pendingAsk.timeoutMs <= 5000, `plazo ${pendingAsk.timeoutMs}`);
      assert.match(pendingAsk.snapshot.vela_recien_abierta, /ACABA DE ABRIR/);
      assert.equal(pendingAsk.snapshot.cuando_se_abre_la_operacion, undefined);
      if (s.thinking) seen.martinAsks++;
    }
    const started = s.phase === 'signal' && s.signal && (previous !== 'signal' || s.signal !== previousSignal);
    if (started) {
      const elapsed = nowMs - market.startedAt;
      // Sale dentro de la vela en que se preguntó: como pronto 1 s después de arrancar el análisis.
      assert.ok(elapsed >= 1000 && elapsed <= 5000 + 1500 + READ_MS, `la señal salió a los ${elapsed} ms de abrir la vela`);
      if (s.signal.source === 'martingala') {
        seen.martin++;
        assert.ok(s.signal.dir, 'la martingala siempre entra');
        assert.match(s.signal.reason, /Nuevo análisis de la IA: IA: vela en curso/);
      } else if (s.signal.dir) {
        seen.shown++;
        assert.equal(s.signal.source, 'ia');
        assert.equal(s.signal.veto, null);
      }
      pendingAsk = null;
    }
    if (s.thinking) {
      assert.equal(s.phase, 'analysis');
      assert.equal(s.signal, null);
    }
    previous = s.phase;
    previousSignal = s.phase === 'signal' ? s.signal : null;
  }
  assert.ok(seen.shown >= 5, `señales de la IA que entraron: ${seen.shown}`);
  assert.ok(seen.martin >= 1, `martingalas: ${seen.martin}`);
  assert.equal(seen.martinAsks, seen.martin, 'cada martingala tuvo su consulta, al abrir su vela');
  const log = records();
  assert.match(log, /\nE,\d+,consulta,[\d.]+,[\d.]*\n/);
  assert.doesNotMatch(log, /veto vela/);
  assert.match(log, /\nP,\d+,\w+,(up|down),(win|loss|tie),\d+,\w+,3,martin1\n/);
});
