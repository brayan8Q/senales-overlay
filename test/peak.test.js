/** Agotamiento: que el precio venga subiendo no significa que vaya a seguir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { tickMomentum, decide, createTimedTracker } = require('../src/timed');
const { computeReadings } = require('../src/readings');
const { describeChart, systemPrompt } = require('../src/ai');
const { chain } = require('./helpers');

// Lecturas del precio cada 300 ms. Se escriben como PRECIOS (mayor = más alto);
// en pantalla la fila es su negativo.
const at = (prices) => prices.map((p, i) => ({ time: i * 300, y: -p }));
const read = (prices) => tickMomentum(at(prices), (prices.length - 1) * 300);

test('giro desde el pico: subió, marcó máximo y ya devolvió parte', () => {
  // Sube 8, marca el pico y devuelve 5
  const r = read([100, 102, 104, 106, 108, 107, 105, 104, 103]);
  assert.equal(r.turn, 'down');
  assert.equal(r.vote, -2);
  assert.equal(r.text, 'giró hacia abajo desde el pico');
  assert.ok(r.net < 0);

  // Devuelve poco (3 de 8): giro leve, 1 voto
  assert.equal(read([100, 102, 104, 106, 108, 107, 106, 105, 105]).vote, -1);
  // Devuelve casi nada (1 de 8): no es giro, sigue "subiendo"
  const still = read([100, 102, 104, 106, 108, 108, 107, 107, 107]);
  assert.equal(still.turn, undefined);

  // Al revés: baja, marca el piso y rebota
  const up = read([100, 98, 96, 94, 92, 93, 95, 96, 97]);
  assert.equal(up.turn, 'up');
  assert.equal(up.vote, 2);
  assert.equal(up.text, 'giró hacia arriba desde el piso');
});

test('no confunde el ruido con un giro', () => {
  // Sube parejo: el máximo es la última lectura
  assert.equal(read([100, 101, 102, 104, 105, 107]).turn, undefined);
  // Zigzag chico sin avance
  assert.equal(read([100, 101, 100, 101, 100, 101, 100]).turn, undefined);
  // Marcó pico, bajó, pero ya va otra vez hacia arriba: no se da por girado
  assert.equal(read([100, 103, 106, 108, 105, 104, 106, 107]).turn, undefined);
});

test('perdiendo fuerza: avanzó al principio y luego casi nada', () => {
  const r = read([100, 102, 104, 106, 107, 107, 107, 107, 107, 107, 107]);
  assert.equal(r.fading, true);
  assert.equal(r.vote, 0);
  assert.equal(r.text, 'subía, perdiendo fuerza');
});

test('vela estirada + giro desde el pico = agotamiento: señal hacia el regreso, no de confianza baja', () => {
  const up = { dir: 'up' };
  const bigUp = { vote: 0, blocks: 'up', text: 'ya muy extendida hacia arriba (3.0 veces lo normal)' };
  const turned = { vote: -2, text: 'giró hacia abajo desde el pico', net: -5, turn: 'down' };
  const rising = { vote: 2, text: 'subiendo con fuerza', net: 6 };

  const d = decide(up, bigUp, ['up'], { ticks: turned, force: true });
  assert.equal(d.dir, 'down');
  assert.notEqual(d.confidence, 'baja');
  assert.match(d.reason, /^Vela agotada: ya estirada y el precio giró desde su extremo/);

  // Si la vela estirada sigue subiendo con fuerza, no hay giro: obligado a elegir, apuesta al regreso pero lo marca "baja"
  const chasing = decide(up, bigUp, ['up'], { ticks: rising, force: true });
  assert.equal(chasing.dir, 'down');
  assert.equal(chasing.confidence, 'baja');

  // Simetría
  const bigDown = { vote: 0, blocks: 'down', text: 'ya muy extendida hacia abajo' };
  const bounced = { vote: 2, text: 'giró hacia arriba desde el piso', net: 5, turn: 'up' };
  assert.equal(decide({ dir: 'down' }, bigDown, ['down'], { ticks: bounced, force: true }).dir, 'up');
});

test('lecturas: racha larga de velas del mismo color o precio en el máximo cuentan en contra', () => {
  const NOON = Date.UTC(2026, 10, 11, 13);
  const of = (candles) => computeReadings({ candles: candles.slice(0, -1), forming: candles[candles.length - 1], time: NOON });

  // 13 velas de lado y luego 6 verdes seguidas hasta el máximo
  const run = of(chain([-2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 3, 3, 3, 3, 3, 3]));
  assert.equal(run.data.agotamiento.velas_seguidas_del_mismo_color, 6);
  assert.equal(run.data.agotamiento.color, 'verde');
  assert.equal(run.data.agotamiento.precio_en_maximo_de_lo_visto, true);
  const summary = run.items.find((i) => i.key === 'summary');
  assert.match(summary.detail, /6 velas verdes seguidas/);
  // Tendencia, EMA y momentum dicen arriba; RSI y agotamiento dicen abajo: el contexto ya no empuja con 2 votos
  assert.ok(run.vote <= 1, String(run.vote));

  // Una subida con retrocesos normales no cuenta como agotamiento por racha
  const healthy = of(chain(Array.from({ length: 30 }, (_, i) => (i % 3 === 2 ? -2 : 3))));
  assert.ok(healthy.data.agotamiento.velas_seguidas_del_mismo_color < 4);
});

test('si la IA contesta y el precio ya va con fuerza en contra, se avisa y queda en confianza baja', () => {
  const candles = chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2, 1]);
  const t = createTimedTracker();
  const base = { candles, cycleMs: 5000, pauseMs: 5000, payout: 85, manual: true, force: true };
  t.update({ ...base, priceY: -100, now: 0 });
  t.predict();
  // El precio cae en cada lectura mientras la IA "piensa"
  let s;
  for (let i = 1; i <= 10; i++) s = t.update({ ...base, priceY: -100 + i, now: i * 300, waitForAdvice: true });
  assert.equal(s.phase, 'analysis');
  s = t.update({ ...base, priceY: -89, now: 3300, advice: { dir: 'up', confidence: 'alta', reason: 'IA: tendencia alcista.' } });
  assert.equal(s.signal.source, 'ia');
  assert.equal(s.signal.dir, 'up'); // la dirección la decide la IA...
  assert.equal(s.signal.confidence, 'baja'); // ...pero se marca
  assert.match(s.signal.reason, /^Ojo: ahora mismo el precio va en contra \(bajando con fuerza\)/);

  // Si el precio va a favor, se respeta la confianza de la IA
  const t2 = createTimedTracker();
  t2.update({ ...base, priceY: -100, now: 0 });
  t2.predict();
  for (let i = 1; i <= 10; i++) s = t2.update({ ...base, priceY: -100 - i, now: i * 300, waitForAdvice: true });
  s = t2.update({ ...base, priceY: -111, now: 3300, advice: { dir: 'up', confidence: 'alta', reason: 'IA: tendencia alcista.' } });
  assert.equal(s.signal.confidence, 'alta');
});

test('a la IA se le pide buscar agotamiento y se le dice cómo va el precio en este instante', () => {
  assert.match(systemPrompt(true), /No des por hecho que un movimiento continúa/);
  assert.match(systemPrompt(false), /agotamiento/);
  const candles = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]);
  const snapshot = describeChart(candles, [], 5, { now: { vote: -2, text: 'giró hacia abajo desde el pico', net: -5, turn: 'down' } });
  assert.equal(snapshot.precio_ahora_mismo, 'giró hacia abajo desde el pico');
});
