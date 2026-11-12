/** Patrón medido: si a este plazo el precio viene continuando o rebotando, y cómo orienta la señal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { measureRegime, valueAt } = require('../src/regime');
const { decide } = require('../src/timed');
const { run, synthetic } = require('../tools/simular');

const H = 5000;
/** Recorrido del precio a partir de los movimientos de cada tramo de 5 s (una lectura cada 250 ms). */
function track(moves) {
  const prices = [];
  let value = 100;
  let time = 0;
  prices.push({ time, value });
  for (const move of moves) {
    for (let k = 1; k <= 20; k++) {
      time += 250;
      prices.push({ time, value: value + (move * k) / 20 });
    }
    value += move;
  }
  return { prices, now: time };
}

test('precio que continúa: lo detecta y vota a favor del último tramo', () => {
  // Rachas largas: 10 tramos arriba, 10 abajo...
  const moves = Array.from({ length: 120 }, (_, i) => (Math.floor(i / 10) % 2 ? -2 : 2));
  const { prices, now } = track(moves);
  const r = measureRegime(prices, H, now);
  assert.equal(r.kind, 'continua');
  assert.ok(r.rate > 85, String(r.rate));
  assert.equal(r.lastMove, -1); // el último tramo bajó
  assert.equal(r.vote, -3); // continúa -> hacia abajo, con fuerza (muy claro)
  assert.match(r.text, /^continúa \d+ % \(\d+ tramos\)$/);
});

test('precio que rebota: lo detecta y vota en contra del último tramo', () => {
  const moves = Array.from({ length: 120 }, (_, i) => (i % 2 ? -2 : 2)); // zigzag
  const { prices, now } = track(moves);
  const r = measureRegime(prices, H, now);
  assert.equal(r.kind, 'rebota');
  assert.equal(r.lastMove, -1);
  assert.equal(r.vote, 3); // bajó -> rebota -> hacia arriba
  assert.match(r.text, /^rebota 100 % /);
});

test('precio al azar o pocos datos: no hay patrón y no vota', () => {
  // Mitad de las veces continúa, mitad rebota (patrón de 4: sube, sube, baja, baja)
  const moves = Array.from({ length: 120 }, (_, i) => (i % 4 < 2 ? 2 : -2));
  const mixed = track(moves);
  const r = measureRegime(mixed.prices, H, mixed.now);
  assert.equal(r.kind, null);
  assert.equal(r.vote, 0);
  assert.match(r.text, /sin patrón claro/);

  const few = track(Array.from({ length: 20 }, (_, i) => (i % 2 ? -2 : 2)));
  const short = measureRegime(few.prices, H, few.now);
  assert.equal(short.kind, null);
  assert.match(short.text, /midiendo… \(\d+ de 24 tramos\)/);
  assert.equal(measureRegime([], H, 0).text, 'midiendo…');
});

test('los huecos sin lectura (gráfica tapada) no se inventan', () => {
  const { prices } = track([2, -2, 2]);
  assert.equal(valueAt(prices, 5000), 102);
  assert.equal(valueAt(prices, 5100), prices.find((p) => p.time === 5000).value);
  assert.equal(valueAt(prices, 60000), null); // demasiado lejos de cualquier lectura
  assert.equal(valueAt([], 0), null);
});

test('cómo orienta la señal: con "rebota" cuentan las lecturas de regreso; con "continúa", las que siguen', () => {
  const up = { dir: 'up' };
  const strongGreen = { vote: 1, text: 'cuerpo fuerte verde' };
  const rising = { vote: 2, text: 'subiendo con fuerza', net: 6 };
  const moves = ['up', 'up'];
  const context = { vote: 2, follow: 2, reverse: 0, text: '3 arriba, 0 abajo' };

  // Sin patrón: todo apunta arriba -> ARRIBA
  assert.equal(decide(up, strongGreen, moves, { ticks: rising, context }).dir, 'up');
  // Patrón "continúa" y el último tramo subió -> ARRIBA, más claro todavía
  const cont = decide(up, strongGreen, moves, { ticks: rising, context, regime: { kind: 'continua', vote: 3, text: 'continúa 64 % (200 tramos)' } });
  assert.equal(cont.dir, 'up');
  assert.equal(cont.confidence, 'alta');
  assert.match(cont.reason, /^Patrón medido: continúa 64 %/);
  // Patrón "rebota" y el último tramo subió -> ABAJO, aunque todo lo demás "siga" hacia arriba
  const reb = decide(up, strongGreen, moves, { ticks: rising, context, regime: { kind: 'rebota', vote: -3, text: 'rebota 62 % (200 tramos)' } });
  assert.equal(reb.dir, 'down');
  assert.match(reb.reason, /^Patrón medido: rebota 62 %/);

  // Vela estirada hacia arriba:
  const bigUp = { vote: 0, blocks: 'up', text: 'ya muy extendida hacia arriba' };
  //  - con "continúa" ya no se apuesta al regreso: se sigue
  const follow = decide(up, bigUp, moves, { ticks: rising, force: true, regime: { kind: 'continua', vote: 3, text: 'continúa 64 %' } });
  assert.equal(follow.dir, 'up');
  assert.notEqual(follow.confidence, 'baja');
  //  - con "rebota" el regreso es la señal, y con confianza
  const fade = decide(up, bigUp, moves, { ticks: rising, force: true, regime: { kind: 'rebota', vote: -3, text: 'rebota 62 %' } });
  assert.equal(fade.dir, 'down');
  assert.equal(fade.confidence, 'alta');

  // Simetría
  const mirrored = decide({ dir: 'down' }, { vote: -1, text: 'cuerpo fuerte rojo' }, ['down', 'down'], {
    ticks: { vote: -2, text: 'bajando con fuerza', net: -6 },
    context: { vote: -2, follow: -2, reverse: 0, text: '0 arriba, 3 abajo' },
    regime: { kind: 'rebota', vote: 3, text: 'rebota 62 %' },
  });
  assert.equal(mirrored.dir, 'up');
});

test('simulación: en azar ~50 %; con patrón medido mejora en mercados que continúan y que rebotan', () => {
  const rate = (stats) => (100 * stats['SEÑAL (todas)'].hits) / stats['SEÑAL (todas)'].n;
  const ticks = Math.round((90 * 60 * 1000) / 300); // 90 minutos de precio
  const horizon = 17; // ~5 s

  const random = rate(run(synthetic('azar', ticks, 1.2, 11), horizon));
  assert.ok(random > 45 && random < 55, `azar ${random.toFixed(1)} %`);

  for (const kind of ['tendencia', 'rebote']) {
    const price = synthetic(kind, ticks, 1.2, 23);
    const before = rate(run(price, horizon, { regime: false }));
    const after = rate(run(price, horizon));
    assert.ok(after > before + 3, `${kind}: ${before.toFixed(1)} % -> ${after.toFixed(1)} %`);
    assert.ok(after > 54, `${kind}: ${after.toFixed(1)} %`);
  }
});
