/** Consejo de IAs, medición con la cotización real y lectura con la gráfica tapada. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { combine, nickname, scoreVotes } = require('../src/council');
const { createTimedTracker } = require('../src/timed');
const { readCandles, findPriceLine, findPriceLabel } = require('../src/candles');
const { createQualityGate } = require('../src/quality');
const gemini = require('../src/ai-gemini');
const claude = require('../src/ai-claude');
const { chain } = require('./helpers');

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const say = (dir, confidence, name, reason = 'porque sí') => ({ dir, confidence, name, reason });

test('nombre corto de cada modelo', () => {
  assert.equal(nickname('openai', 'gpt-6-astra'), 'Astra');
  assert.equal(nickname('claude', 'claude-fable-5-2'), 'Fable');
  assert.equal(nickname('gemini', 'gemini-3-argon'), 'Argon');
  assert.equal(nickname('openai', 'gpt-4o-mini'), 'GPT'); // sin apodo: el del proveedor
  assert.equal(nickname('gemini', 'gemini-2.5-pro'), 'Gemini');
  assert.equal(nickname('claude', null), 'Claude');
});

test('una sola IA: vale lo que diga, con su confianza', () => {
  const c = combine({ openai: say('up', 'media', 'Astra', 'mecha larga abajo') });
  assert.equal(c.dir, 'up');
  assert.equal(c.confidence, 'media');
  assert.equal(c.reason, 'mecha larga abajo');
  assert.equal(combine({}), null);
});

test('varias IA: gana la mayoría; unánimes = confianza alta', () => {
  const all = combine({ openai: say('down', 'media', 'Astra'), gemini: say('down', 'baja', 'Argon'), claude: say('down', 'media', 'Fable') });
  assert.equal(all.dir, 'down');
  assert.equal(all.confidence, 'alta');
  assert.equal(all.votes, 'Astra ▼ · Argon ▼ · Fable ▼');
  assert.match(all.reason, /^Astra ▼ · Argon ▼ · Fable ▼\. Astra: /);

  // Dos contra una: gana la mayoría, pero con la confianza bajada un nivel
  const split = combine({ openai: say('up', 'alta', 'Astra'), gemini: say('down', 'alta', 'Argon'), claude: say('up', 'media', 'Fable') });
  assert.equal(split.dir, 'up');
  assert.equal(split.confidence, 'media');
  assert.equal(split.votes, 'Astra ▲ · Argon ▼ · Fable ▲');

  // Una no eligió lado y las otras dos coinciden
  const two = combine({ openai: say('up', 'media', 'Astra'), gemini: say(null, 'ninguna', 'Argon'), claude: say('up', 'baja', 'Fable') });
  assert.equal(two.dir, 'up');
  assert.equal(two.confidence, 'alta');
  assert.equal(two.votes, 'Astra ▲ · Argon – · Fable ▲');
});

test('empate entre dos IA: decide la que está más segura; si empatan del todo, no hay consejo', () => {
  const byWeight = combine({ openai: say('up', 'baja', 'Astra'), claude: say('down', 'alta', 'Fable', 'agotamiento') });
  assert.equal(byWeight.dir, 'down');
  assert.equal(byWeight.confidence, 'baja');
  assert.match(byWeight.reason, /Fable: agotamiento/);

  const tie = combine({ openai: say('up', 'media', 'Astra'), claude: say('down', 'media', 'Fable') });
  assert.equal(tie.dir, null); // la señal saldrá de las reglas del panel
  assert.match(tie.reason, /Empate entre las IA/);

  const none = combine({ openai: say(null, 'ninguna', 'Astra'), claude: say(null, 'ninguna', 'Fable') });
  assert.equal(none.dir, null);
});

test('marcador de cada IA: se anota contra hacia dónde fue el precio de verdad', () => {
  const scores = {};
  scoreVotes(scores, { openai: 'up', gemini: 'down', claude: 'up' }, 'up');
  scoreVotes(scores, { openai: 'up', gemini: 'down', claude: null }, 'down');
  scoreVotes(scores, { openai: 'up' }, null); // señal sin medir: no cuenta
  assert.deepEqual(scores, { openai: { wins: 1, losses: 1 }, gemini: { wins: 1, losses: 1 }, claude: { wins: 1, losses: 0 } });
});

test('a cada IA se le recuerdan sus predicciones anteriores y lo que pasó', () => {
  const { rememberOutcome, feedbackFor } = require('../src/council');
  const { systemPrompt } = require('../src/ai');
  const memory = {};
  assert.equal(feedbackFor(memory.openai), null); // sin nada medido no se manda nada

  rememberOutcome(memory, { openai: say('up', 'alta', 'Astra', 'tendencia alcista'), claude: say('down', 'media', 'Fable', 'agotamiento') }, 'down');
  rememberOutcome(memory, { openai: say('up', 'media', 'Astra', 'cuerpo fuerte'), claude: say(null, 'ninguna', 'Fable') }, 'up');
  rememberOutcome(memory, { openai: say('down', 'baja', 'Astra') }, null); // señal sin medir: no se guarda

  const astra = feedbackFor(memory.openai);
  assert.equal(astra.aciertos, '1 de 2');
  assert.deepEqual(astra.lista, [
    { dijiste: 'subiria', paso: 'bajo', acertaste: false, tu_razon: 'tendencia alcista' },
    { dijiste: 'subiria', paso: 'subio', acertaste: true, tu_razon: 'cuerpo fuerte' },
  ]);
  // Cada IA solo ve lo suyo; la que no eligió lado no guarda esa señal
  assert.equal(feedbackFor(memory.claude).aciertos, '1 de 1');
  assert.equal(memory.gemini, undefined);

  // Solo se conservan las 10 más recientes
  for (let i = 0; i < 15; i++) rememberOutcome(memory, { gemini: say('up', 'media', 'Argon', `razón ${i}`) }, i % 2 ? 'up' : 'down');
  assert.equal(memory.gemini.length, 10);
  assert.equal(feedbackFor(memory.gemini).lista[9].tu_razon, 'razón 14');

  assert.match(systemPrompt(true), /tus_ultimas_predicciones/);
  assert.match(systemPrompt(true), /No lo uses para adivinar rachas/);
});

test('elección de modelo: Gemini prefiere "argon"; Claude, Fable 5.2', () => {
  assert.equal(gemini.pickModel(['gemini-2.5-flash', 'gemini-3-argon', 'gemini-2.5-pro']), 'gemini-3-argon');
  assert.equal(gemini.pickModel(['gemini-2.5-flash', 'gemini-2.5-pro', 'imagen-4']), 'gemini-2.5-pro');
  assert.equal(gemini.pickModel(['gemini-2.5-flash'], 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.deepEqual(gemini.chatModels(['gemini-2.5-pro', 'text-embedding-004', 'imagen-4', 'gemini-2.5-flash-preview-tts']), ['gemini-2.5-pro']);
  assert.equal(claude.pickModel(['claude-opus-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']), 'claude-fable-5-2');
  assert.equal(claude.pickModel(['claude-opus-5-5', 'claude-haiku-5-5']), 'claude-opus-5-5');
  assert.equal(claude.pickModel(['claude-opus-5-5', 'claude-haiku-5-5'], 'claude-haiku-5-5'), 'claude-haiku-5-5');
  assert.equal(claude.pickModel([]), null);
});

test('etiqueta del precio en el eje: da la fila del precio sin depender de las velas', () => {
  for (const [name, expected] of [['eje_real.png', 414], ['eje_usdmxn.png', 55]]) {
    const png = load(name);
    const row = findPriceLabel(png.data, png.width, png.height);
    assert.ok(row !== null && Math.abs(row - expected) <= 1.5, `${name}: ${row}`);
    // La línea del precio pasa por ahí aunque no se le dé la pista de la vela en curso
    assert.ok(Math.abs(findPriceLine(png.data, png.width, png.height, row) - expected) <= 1, name);
  }
  // Sin eje a la vista no hay etiqueta
  const plain = load('grafica_real.png');
  assert.equal(findPriceLabel(plain.data, plain.width, plain.height), null);
});

test('el control de lectura dice qué parte está tapada, sin bloquear', () => {
  const png = load('grafica_real2.png'); // globo del resultado sobre la vela actual
  const candles = readCandles(png.data, png.width, png.height);
  const priceY = findPriceLine(png.data, png.width, png.height, -candles[candles.length - 1].close);
  const check = createQualityGate().inspect(candles, priceY, 0);
  assert.equal(check.forming, false);
  assert.equal(check.complete, true);
  assert.match(check.reason, /tapa la vela actual/);
});

test('con la cotización real, la señal se califica aunque las velas estén tapadas o sean otras', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const garbage = chain([-1, -1, 5, 5, -7, 2, -3, 9, -1, -6, 4, 4]); // lo que se lee con un aviso encima
  const base = { cycleMs: 5000, payout: 85, force: true };
  const quote = (value) => ({ value, perPixel: 0.00004 });
  const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];

  const t = createTimedTracker();
  let s = t.update({ ...base, candles, priceY: -112, now: 0, quote: quote(1.2) });
  assert.equal(s.signal.dir, 'up');
  // A los 5 s las velas no se reconocen (aviso encima), pero la cotización subió: acertó
  s = t.update({ ...base, candles: garbage, priceY: -90, now: 5000, quote: quote(1.20012), formingOk: false });
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.lastResult, 'acertó');

  // Sin cotización real, en la misma situación no se puede medir (y no se inventa)
  const t2 = createTimedTracker();
  t2.update({ ...base, candles, priceY: -112, now: 0 });
  s = t2.update({ ...base, candles: garbage, priceY: -90, now: 5000 });
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.match(s.lastResult, /no se pudo medir/);

  // Movimiento menor a medio pixel: empate
  const t3 = createTimedTracker();
  t3.update({ ...base, candles, priceY: -112, now: 0, quote: quote(1.2) });
  s = t3.update({ ...base, candles, priceY: -112, now: 5000, quote: quote(1.20001) });
  assert.deepEqual(tally(s), [0, 0, 1]);
});

test('con la cotización real, el movimiento lectura a lectura se sigue aunque la escala cambie', () => {
  const candles = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1]);
  const t = createTimedTracker();
  let s;
  // El precio real sube 1 pip por lectura; la escala de la pantalla (perPixel) va cambiando
  for (let i = 0; i <= 10; i++) {
    s = t.update({
      candles,
      priceY: -100,
      now: i * 300,
      cycleMs: 60000,
      payout: 85,
      manual: true,
      quote: { value: 1.2 + i * 0.0001, perPixel: 0.00004 * (1 + i * 0.05) },
    });
  }
  assert.equal(s.ticks.length, 11);
  t.predict();
  s = t.update({ candles, priceY: -100, now: 3300, cycleMs: 60000, payout: 85, manual: true, quote: { value: 1.2011, perPixel: 0.00006 } });
  assert.equal(s.signal.dir, 'up');
  assert.match(s.signal.reason, /Precio subiendo con fuerza/);
});

test('vela en curso tapada: su patrón no vota, pero la señal sale igual', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const t = createTimedTracker();
  const s = t.update({ candles, priceY: -112, now: 0, cycleMs: 5000, payout: 85, force: true, quote: { value: 1.2, perPixel: 0.00004 }, formingOk: false });
  assert.equal(s.phase, 'signal');
  assert.ok(s.signal.dir === 'up' || s.signal.dir === 'down');
  assert.match(s.signal.reason, /vela actual: tapada por un aviso de la plataforma/);
});
