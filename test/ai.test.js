/** Cliente de la IA contra un servidor falso local (no se llama a OpenAI ni se usa una clave real). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { listModels, pickModel, describeChart, askDirection, parseAnswer } = require('../src/ai');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

/** Levanta un servidor que imita la API; `handler(req, body, n)` devuelve { status, json | text, delayMs }. */
async function fakeApi(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      const out = handler(req, body, calls.length);
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
const chat = (content) => ({ json: { choices: [{ message: { content } }] } });
const KEY = 'sk-clave-de-prueba-no-real-000000';

test('elige un modelo que la cuenta sí tenga', () => {
  assert.equal(pickModel(['gpt-4o', 'gpt-4o-mini', 'whisper-1']), 'gpt-4o-mini');
  assert.equal(pickModel(['gpt-4o', 'gpt-4o-mini'], 'gpt-4o'), 'gpt-4o'); // el ya elegido, si sigue existiendo
  assert.equal(pickModel(['gpt-4o', 'gpt-4o-mini'], 'modelo-retirado'), 'gpt-4o-mini');
  assert.equal(pickModel(['gpt-9-mini', 'gpt-9', 'gpt-9-mini-tts']), 'gpt-9-mini'); // modelos que aún no conozco
  assert.equal(pickModel(['gpt-9']), 'gpt-9');
  assert.equal(pickModel(['whisper-1', 'dall-e-3']), null);
});

test('comprueba la clave y lista modelos', async () => {
  const api = await fakeApi(() => ({ json: { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] } }));
  try {
    assert.deepEqual(await listModels({ baseUrl: api.baseUrl, key: KEY }), ['gpt-4o-mini', 'gpt-4o']);
    assert.equal(api.calls[0].url, '/v1/models');
    assert.equal(api.calls[0].auth, `Bearer ${KEY}`);
  } finally {
    await api.close();
  }
});

test('clave inválida, sin saldo y sin conexión dan mensajes claros (y nunca muestran la clave)', async () => {
  const api = await fakeApi((req) => ({
    status: req.url.includes('models') ? 401 : 429,
    json: { error: { message: `Incorrect API key provided: ${KEY}` } },
  }));
  try {
    await assert.rejects(listModels({ baseUrl: api.baseUrl, key: KEY }), (err) => {
      assert.match(err.message, /no es válida/);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
    await assert.rejects(
      askDirection({ baseUrl: api.baseUrl, key: KEY, model: 'gpt-4o-mini', snapshot: {} }),
      /Sin saldo o demasiadas consultas/,
    );
  } finally {
    await api.close();
  }
  await assert.rejects(
    listModels({ baseUrl: 'http://127.0.0.1:9/v1', key: KEY, timeoutMs: 1500 }),
    /No se pudo conectar|tardó/,
  );
});

test('pregunta la dirección y entiende la respuesta', async () => {
  const api = await fakeApi(() => chat('{"dir":"down","reason":"Mecha larga arriba tras subida fuerte."}'));
  try {
    const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
    const snapshot = describeChart(candles, ['up', 'down'], 15);
    const answer = await askDirection({ baseUrl: api.baseUrl, key: KEY, model: 'gpt-4o-mini', snapshot });
    assert.deepEqual(answer, { dir: 'down', confidence: 'media', reason: 'Mecha larga arriba tras subida fuerte.', usage: { input: 0, output: 0 } });

    const sent = api.calls[0].body;
    assert.equal(api.calls[0].url, '/v1/chat/completions');
    assert.equal(sent.model, 'gpt-4o-mini');
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    const user = JSON.parse(sent.messages[1].content);
    assert.equal(user.segundos_a_predecir, 15);
    assert.equal(user.velas_cerradas.length, 9);
    assert.equal(user.vela_en_curso.length, 4);
    assert.deepEqual(user.movimientos_recientes_del_precio, ['subio', 'bajo']);
    assert.equal(user.velas_cerradas[0][0], 0); // la primera abre en 0
  } finally {
    await api.close();
  }
});

test('si el modelo no acepta el formato JSON, reintenta sin él', async () => {
  const api = await fakeApi((req, body, n) =>
    n === 1
      ? { status: 400, json: { error: { message: 'response_format not supported' } } }
      : chat('Creo que {"dir":"up","reason":"Rebote."} es lo más probable'),
  );
  try {
    const answer = await askDirection({ baseUrl: api.baseUrl, key: KEY, model: 'x', snapshot: {} });
    assert.deepEqual(answer, { dir: 'up', confidence: 'media', reason: 'Rebote.', usage: { input: 0, output: 0 } });
    assert.equal(api.calls.length, 2);
    assert.equal(api.calls[1].body.response_format, undefined);
  } finally {
    await api.close();
  }
});

test('si tarda demasiado, se corta', async () => {
  const api = await fakeApi(() => ({ ...chat('{"dir":"up","reason":"x"}'), delayMs: 1200 }));
  try {
    await assert.rejects(
      askDirection({ baseUrl: api.baseUrl, key: KEY, model: 'x', snapshot: {}, timeoutMs: 300 }),
      /tardó demasiado/,
    );
  } finally {
    await api.close();
  }
});

test('respuestas raras se toman como esperar', () => {
  assert.deepEqual(parseAnswer('{"dir":"UP","reason":"  sube   fuerte "}'), {
    dir: 'up',
    confidence: 'media',
    reason: 'sube fuerte',
  });
  assert.equal(parseAnswer('{"dir":"down","confidence":"BAJA","reason":"x"}').confidence, 'baja');
  assert.equal(parseAnswer('{"dir":"up","confidence":"altísima","reason":"x"}').confidence, 'media');
  assert.equal(parseAnswer('{"dir":"wait","confidence":"alta","reason":"x"}').confidence, 'ninguna');
  assert.equal(parseAnswer('{"dir":"wait","reason":"sin lectura"}').dir, null);
  assert.equal(parseAnswer('{"dir":"sideways"}').dir, null);
  assert.equal(parseAnswer('no sé').dir, null);
  assert.equal(parseAnswer('').dir, null);
  assert.equal(parseAnswer(`{"dir":"down","reason":"${'x'.repeat(400)}"}`).reason.length, 160);
});

test('en el marcador: si la IA opinó, manda ella; si no, las reglas', () => {
  const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // las reglas dicen ARRIBA
  const run = (advice) => {
    const t = createTimedTracker();
    return t.update({ candles: UP, priceY: -112, now: 0, cycleMs: 15000, payout: 85, advice });
  };
  const rules = run(null);
  assert.equal(rules.signal.dir, 'up');
  assert.equal(rules.signal.source, 'reglas');
  assert.equal(rules.signal.readings.trend.lean, 'up');

  const ia = run({ dir: 'down', reason: 'IA: mecha de rechazo.' });
  assert.equal(ia.signal.dir, 'down');
  assert.equal(ia.signal.source, 'ia');
  assert.equal(ia.signal.reason, 'IA: mecha de rechazo.');
  assert.equal(ia.signal.readings.trend.text, 'arriba'); // las lecturas del panel se siguen mostrando

  // La IA también puede decir ESPERAR
  assert.equal(run({ dir: null, reason: 'IA: sin lectura clara.' }).signal.dir, null);

  // Y la señal de la IA se califica igual que cualquier otra
  const t = createTimedTracker();
  t.update({ candles: UP, priceY: -112, now: 0, cycleMs: 15000, payout: 85, advice: { dir: 'down', reason: 'IA: x' } });
  const s = t.update({ candles: UP, priceY: -115, now: 15000, cycleMs: 15000, payout: 85 }); // el precio subió
  assert.deepEqual([s.live.wins, s.live.losses], [0, 1]);
});
