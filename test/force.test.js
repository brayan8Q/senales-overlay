/** Modo "dar siempre ARRIBA o ABAJO": nunca ESPERAR, marcando las señales de confianza baja. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { decide, createTimedTracker } = require('../src/timed');
const { askDirection, systemPrompt } = require('../src/ai');
const { chain } = require('./helpers');
const { generate } = require('./gen');

const up = { dir: 'up' };
const down = { dir: 'down' };
const side = { dir: null };
const none = { vote: 0, text: 'sin fuerza' };
const bull = { vote: 1, text: 'cuerpo fuerte verde' };
const stretchedUp = { vote: 0, blocks: 'up', text: 'ya muy extendida hacia arriba' };
const stretchedDown = { vote: 0, blocks: 'down', text: 'ya muy extendida hacia abajo' };
const force = { force: true };

test('sin forzar se comporta como antes', () => {
  assert.equal(decide(up, none, []).dir, null);
  assert.equal(decide(up, none, []).confidence, 'ninguna');
  assert.equal(decide(up, bull, []).confidence, 'media');
  assert.equal(decide(up, bull, ['up', 'up']).confidence, 'alta');
});

test('forzado: con dos votos o más no cambia nada', () => {
  const a = decide(up, bull, ['up'], force);
  assert.equal(a.dir, 'up');
  assert.equal(a.confidence, 'alta');
  assert.doesNotMatch(a.reason, /Confianza baja/);
});

test('forzado: sin dos votos elige el lado hacia el que se inclina y avisa', () => {
  // Un solo voto
  let d = decide(up, none, [], force);
  assert.equal(d.dir, 'up');
  assert.equal(d.confidence, 'baja');
  assert.match(d.reason, /Confianza baja/);
  assert.equal(decide(down, none, [], force).dir, 'down');
  // Votos que se anulan: manda el último movimiento del precio
  assert.equal(decide(up, none, ['down'], force).dir, 'down');
  assert.equal(decide(down, none, ['up'], force).dir, 'up');
  // Nada de nada: el color de la vela en curso, y como último recurso un lado fijo
  assert.equal(decide(side, none, [], { force: true, fallback: 'down' }).dir, 'down');
  assert.equal(decide(side, none, ['flat'], { force: true, fallback: 'up' }).dir, 'up');
  assert.ok(['up', 'down'].includes(decide(side, none, [], force).dir));
});

test('forzado: ante una vela muy estirada apuesta al regreso, con confianza baja', () => {
  let d = decide(up, stretchedUp, ['up', 'up'], force); // todo empuja arriba, pero la vela ya se estiró
  assert.equal(d.dir, 'down');
  assert.equal(d.confidence, 'baja');
  assert.match(d.reason, /posible regreso/);
  d = decide(down, stretchedDown, ['down', 'down'], force);
  assert.equal(d.dir, 'up');
  // Estirada y sin votos netos: también hacia el regreso
  assert.equal(decide(side, stretchedUp, [], force).dir, 'down');
});

test('forzado: nunca devuelve ESPERAR y sigue siendo simétrico', () => {
  const flip = { up: 'down', down: 'up' };
  const trends = [up, down, side];
  const patterns = [none, bull, { vote: -1, text: 'rechazo' }, stretchedUp, stretchedDown];
  const moveSets = [[], ['up'], ['down'], ['flat'], ['up', 'up'], ['down', 'down', 'down'], ['up', 'down']];
  for (const t of trends) {
    for (const p of patterns) {
      for (const m of moveSets) {
        for (const fallback of ['up', 'down']) {
          const d = decide(t, p, m, { force: true, fallback });
          assert.ok(d.dir === 'up' || d.dir === 'down', 'debe elegir un lado');
          const mirrored = decide(
            { dir: flip[t.dir] || null },
            { vote: -p.vote, text: p.text, blocks: flip[p.blocks] },
            m.map((x) => flip[x] || 'flat'),
            { force: true, fallback: flip[fallback] },
          );
          assert.equal(mirrored.dir, flip[d.dir]);
        }
      }
    }
  }
});

test('en el marcador: forzado da señal en todos los ciclos', () => {
  // Paseo aleatorio: sin forzar habría ciclos en ESPERAR; forzado, ninguno.
  const all = generate(3, 60).map((c, i) => ({ ...c, x0: i * 10, x1: i * 10 + 7 }));
  const run = (forceOn) => {
    const t = createTimedTracker();
    let waits = 0;
    let signals = 0;
    for (let n = 12; n < 60; n++) {
      const candles = all.slice(n - 12, n);
      const price = candles[candles.length - 1].close;
      const s = t.update({ candles, priceY: -price, now: (n - 12) * 5000, cycleMs: 5000, payout: 85, force: forceOn });
      if (s.signal) {
        signals++;
        if (!s.signal.dir) waits++;
      }
    }
    return { waits, signals };
  };
  assert.ok(run(false).waits > 0, 'sin forzar debe haber algún ESPERAR en esta serie');
  const forced = run(true);
  assert.ok(forced.signals > 20);
  assert.equal(forced.waits, 0);
});

test('forzado con IA: si la IA no elige lado se usan las reglas; si elige, manda ella', () => {
  const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const start = (advice, forceOn) =>
    createTimedTracker().update({ candles: UP, priceY: -112, now: 0, cycleMs: 5000, payout: 85, advice, force: forceOn });

  let s = start({ dir: null, confidence: 'ninguna', reason: 'IA: sin lectura.' }, true);
  assert.equal(s.signal.dir, 'up');
  assert.equal(s.signal.source, 'reglas');

  s = start({ dir: 'down', confidence: 'baja', reason: 'IA: posible giro.' }, true);
  assert.equal(s.signal.dir, 'down');
  assert.equal(s.signal.source, 'ia');
  assert.equal(s.signal.confidence, 'baja');

  // Sin forzar, la IA sí puede dejarlo en ESPERAR
  s = start({ dir: null, confidence: 'ninguna', reason: 'IA: sin lectura.' }, false);
  assert.equal(s.signal.dir, null);
  assert.equal(s.signal.source, 'ia');
});

test('a la IA se le pide elegir siempre un lado cuando está forzado', async () => {
  assert.match(systemPrompt(true), /Debes elegir siempre "up" o "down"/);
  assert.doesNotMatch(systemPrompt(true), /"wait"/);
  assert.match(systemPrompt(false), /"wait"/);

  let sent = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      sent = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const content = JSON.stringify({ dir: 'up', confidence: 'baja', reason: 'Lateral; leve sesgo alcista.' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const answer = await askDirection({ baseUrl, key: 'sk-clave-de-prueba-no-real-000000', model: 'x', snapshot: {}, force: true });
    assert.deepEqual(answer, { dir: 'up', confidence: 'baja', reason: 'Lateral; leve sesgo alcista.', usage: { input: 0, output: 0 } });
    assert.match(sent.messages[0].content, /Debes elegir siempre/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
