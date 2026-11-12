/** Lectura limpia: no se analiza una gráfica tapada por avisos o globos de la plataforma. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles, findPriceLine } = require('../src/candles');
const { createQualityGate } = require('../src/quality');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

function load(name) {
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
  const candles = readCandles(png.data, png.width, png.height);
  const last = candles[candles.length - 1];
  return { candles, priceY: findPriceLine(png.data, png.width, png.height, last ? -last.close : null) };
}

test('capturas reales limpias: la línea del precio pasa por el cierre de la vela actual', () => {
  for (const name of ['grafica_real.png', 'grafica_real3.png']) {
    const { candles, priceY } = load(name);
    const gate = createQualityGate();
    assert.ok(Math.abs(priceY - -candles[candles.length - 1].close) <= 2, name);
    assert.equal(gate.check(candles, priceY, 0), null, name);
  }
});

test('captura real con operación abierta: la rayita de la orden ya no deforma la vela actual', () => {
  // La plataforma dibuja "▲$1" con una raya verde unos píxeles por encima de la vela en curso.
  const { candles, priceY } = load('grafica_real4.png');
  const forming = candles[candles.length - 1];
  assert.equal(forming.dir, 'up');
  assert.ok(Math.abs(priceY - -forming.close) <= 2, `línea ${priceY}, cierre ${-forming.close}`);
  assert.equal(createQualityGate().check(candles, priceY, 0), null);
});

test('captura real con el globo del resultado sobre la vela actual: se detecta como tapada', () => {
  const { candles, priceY } = load('grafica_real2.png');
  const why = createQualityGate().check(candles, priceY, 0);
  assert.match(why, /tapa la vela actual/);
});

test('si de golpe faltan varias velas (aviso "Trade closed"), la lectura no se usa', () => {
  const gate = createQualityGate();
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4, -2, 3, -1, 2, 3, -2, 4, -3, 2, 1]);
  const priceY = -candles[candles.length - 1].close;
  for (let i = 0; i < 10; i++) assert.equal(gate.check(candles, priceY, i * 300), null);
  // Una o dos velas menos se toleran (salen por la izquierda)
  assert.equal(gate.check(candles.slice(2), priceY, 3000), null);
  // Cinco velas menos: tapadas
  assert.match(gate.check(candles.slice(5), priceY, 3300), /tapa 5 velas/);
  // Vuelven: lectura buena otra vez
  assert.equal(gate.check(candles, priceY, 3600), null);
  // Si el usuario cambió el zoom de verdad, a los 10 s se acepta la vista nueva
  for (let i = 0; i < 40; i++) gate.check(candles.slice(8), priceY, 4000 + i * 300);
  assert.equal(gate.check(candles.slice(8), priceY, 16500), null);
});

test('con la gráfica tapada no se empieza una señal; al destaparse, sigue', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const base = { candles, cycleMs: 5000, payout: 85, manual: true, force: true };
  const t = createTimedTracker();
  let s = t.update({ ...base, priceY: -112, now: 0 });
  assert.equal(s.ready, true);
  s = t.update({ ...base, priceY: -112, now: 300, clean: false });
  assert.equal(s.status, 'covered');
  assert.equal(s.ready, false); // no se puede pulsar PREDECIR con la gráfica tapada
  t.update({ ...base, priceY: -112, now: 600 });
  t.predict();
  s = t.update({ ...base, priceY: -112, now: 900, clean: false });
  assert.equal(s.signal, null); // pedida, pero espera
  s = t.update({ ...base, priceY: -112, now: 1200 });
  assert.equal(s.phase, 'signal');
});

test('calificar con la gráfica tapada: usa la última lectura buena o espera a que se destape', () => {
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const base = { candles, cycleMs: 5000, payout: 85, force: true };
  const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
  const start = () => {
    const t = createTimedTracker();
    const s = t.update({ ...base, priceY: -112, now: 0 });
    assert.equal(s.signal.dir, 'up');
    return t;
  };

  // a) Se tapa justo al final, pero había una lectura buena 300 ms antes: se califica con esa
  let t = start();
  t.update({ ...base, priceY: -115, now: 4700 });
  let s = t.update({ ...base, priceY: -90, now: 5000, clean: false }); // lectura tapada (precio falso)
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.lastResult, 'acertó');

  // b) Tapada desde antes: espera, y califica con la primera lectura buena si llega pronto
  t = start();
  t.update({ ...base, priceY: -113, now: 3000 });
  s = t.update({ ...base, priceY: -90, now: 5000, clean: false });
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.equal(s.phase, 'signal'); // sigue pendiente
  s = t.update({ ...base, priceY: -110, now: 5900 }); // se destapó 0.9 s después: bajó -> falló
  assert.deepEqual(tally(s), [0, 1, 0]);

  // c) Tapada demasiado tiempo: no se inventa el resultado
  t = start();
  t.update({ ...base, priceY: -113, now: 3000 });
  for (let now = 5000; now <= 9300; now += 300) s = t.update({ ...base, priceY: -90, now, clean: false });
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.match(s.lastResult, /la gráfica estaba tapada/);

  // d) Se destapa tarde (3 s después): tampoco se califica con un precio de otro momento
  t = start();
  t.update({ ...base, priceY: -113, now: 3000 });
  t.update({ ...base, priceY: -90, now: 5000, clean: false });
  s = t.update({ ...base, priceY: -120, now: 8000 });
  assert.deepEqual(tally(s), [0, 0, 0]);
  assert.match(s.lastResult, /la gráfica estaba tapada/);
});
