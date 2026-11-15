const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBotBridge, httpRequest } = require('../src/botbridge');

// Puente al bot de Pocket: sin tarjeta no hay bot; con tarjeta se le habla con su clave; solo
// cuenta como disponible si está conectado y su cuenta es DEMO.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lector-bot-'));
const card = (data) => fs.writeFileSync(path.join(dir, 'lector.json'), JSON.stringify(data));

test('sin carpeta propia, en las pruebas el puente queda apagado: nunca se habla con un bot de verdad', async () => {
  const calls = [];
  const bridge = createBotBridge({ request: async (r) => calls.push(r) });
  assert.equal((await bridge.refresh()).online, false);
  await assert.rejects(bridge.order({ asset: 'EUR/USD OTC', dir: 'up', seconds: 3, level: 0 }), /no está abierto/);
  assert.equal(calls.length, 0);
});

test('sin tarjeta el bot no está abierto', async () => {
  const bridge = createBotBridge({ dir, request: async () => assert.fail('no debe pedir nada') });
  const s = await bridge.refresh();
  assert.equal(s.online, false);
  await assert.rejects(bridge.order({}), /no está abierto/);
});

test('con tarjeta: pregunta el estado con su clave; disponible solo si está conectado y es DEMO', async () => {
  card({ port: 4321, token: 'clave', pid: 1 });
  const calls = [];
  let answer = { ok: true, connected: true, demo: true, balance: 987.5, stake: 1, factor: 2.2, levels: 1 };
  const bridge = createBotBridge({ dir, request: async (r) => (calls.push(r), answer) });
  let s = await bridge.refresh();
  assert.deepEqual(calls[0], { port: 4321, token: 'clave', method: 'GET', target: '/estado', body: null, timeoutMs: 1500 });
  assert.equal(s.online, true);
  assert.equal(s.balance, 987.5);
  assert.equal(bridge.status().levels, 1);
  // Conectado pero NO demo: no se usa.
  answer = { ok: true, connected: true, demo: false, balance: 50 };
  s = await bridge.refresh();
  assert.equal(s.online, false);
  assert.equal(s.connected, true);
  // Sin conexión con Pocket: tampoco.
  answer = { ok: true, connected: false, demo: true, balance: null };
  assert.equal((await bridge.refresh()).online, false);
});

test('orden y resultado: lo que se le pide al bot', async () => {
  card({ port: 4321, token: 'clave', pid: 1 });
  const calls = [];
  const bridge = createBotBridge({ dir, request: async (r) => (calls.push(r), { ok: true, id: 'A1' }) });
  await bridge.refresh();
  await bridge.order({ asset: 'EUR/USD OTC', dir: 'down', seconds: 3, level: 1 });
  await bridge.result('A1', 3);
  assert.deepEqual(calls[1], { port: 4321, token: 'clave', method: 'POST', target: '/orden', body: { asset: 'EUR/USD OTC', dir: 'down', seconds: 3, level: 1 }, timeoutMs: 9500 });
  assert.deepEqual(calls[2], { port: 4321, token: 'clave', method: 'GET', target: '/resultado?id=A1', body: null, timeoutMs: 28000 });
});

test('si el bot se cierra (o no contesta), el puente lo nota', async () => {
  card({ port: 4321, token: 'clave', pid: 1 });
  let fail = false;
  const bridge = createBotBridge({ dir, request: async () => (fail ? Promise.reject(new Error('conexión rechazada')) : { ok: true, connected: true, demo: true, balance: 10 }) });
  assert.equal((await bridge.refresh()).online, true);
  fail = true;
  const s = await bridge.refresh();
  assert.equal(s.online, false);
  assert.match(s.error, /rechazada/);
  fs.unlinkSync(path.join(dir, 'lector.json'));
  assert.equal((await bridge.refresh()).online, false);
});

test('la petición real: manda la clave en la cabecera y lee el JSON', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-lector-token'], body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, eco: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const got = await httpRequest({ port, token: 'clave', method: 'POST', target: '/orden', body: { dir: 'up' }, timeoutMs: 2000 });
  assert.deepEqual(got, { ok: true, eco: { dir: 'up' } });
  assert.deepEqual(seen[0], { method: 'POST', url: '/orden', token: 'clave', body: '{"dir":"up"}' });
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(httpRequest({ port, token: 'clave', method: 'GET', target: '/estado', timeoutMs: 500 }));
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
