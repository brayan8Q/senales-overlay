const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestEntry, suggestZone, MIN_EDGE, MAX_EDGE, BACK } = require('../src/entry');
const { createTimedTracker } = require('../src/timed');
const { chain } = require('./helpers');

// Vela típica de 20. El precio está en 100 (fila -100) y la vela en curso va de 92 a 106.
const forming = { open: 96, high: 106, low: 92, close: 100 };
const base = { priceY: -100, forming, unit: 20 };
const up = { vote: 1 };
const down = { vote: -1 };
const quiet = { vote: 0 };

test('VENTA: la entrada se sugiere ARRIBA del precio; en la orilla si el precio viene subiendo', () => {
  const e = suggestEntry({ ...base, dir: 'down', momentum: up });
  assert.equal(e.kind, 'orilla');
  assert.equal(e.text, 'orilla alta');
  assert.equal(-e.row, 106); // el máximo de la vela en curso
});

test('VENTA con el precio quieto o ya bajando: a media zona (más cerca, para que sí llegue)', () => {
  for (const momentum of [quiet, down, null]) {
    const e = suggestEntry({ ...base, dir: 'down', momentum });
    assert.equal(e.kind, 'media');
    assert.equal(e.text, 'media zona');
    assert.equal(-e.row, 103); // a mitad de camino entre 100 y 106
  }
});

test('COMPRA: la entrada se sugiere ABAJO del precio; orilla baja si el precio viene bajando', () => {
  const edge = suggestEntry({ ...base, dir: 'up', momentum: down });
  assert.equal(edge.text, 'orilla baja');
  assert.equal(-edge.row, 92); // el mínimo de la vela en curso
  const mid = suggestEntry({ ...base, dir: 'up', momentum: up });
  assert.equal(mid.text, 'media zona');
  assert.equal(-mid.row, 96);
});

test('la orilla nunca queda pegada al precio ni más lejos de lo que el precio suele recorrer', () => {
  // El precio YA está en el máximo de la vela: la orilla se pone a 0.15 velas típicas.
  const atHigh = suggestEntry({ dir: 'down', priceY: -106, forming, unit: 20, momentum: up });
  assert.equal(-atHigh.row, 106 + MIN_EDGE * 20);
  // La vela tiene una mecha enorme: la orilla no pasa de 0.6 velas típicas.
  const far = suggestEntry({ dir: 'down', priceY: -100, forming: { ...forming, high: 160 }, unit: 20, momentum: up });
  assert.equal(-far.row, 100 + MAX_EDGE * 20);
});

test('sin lado, sin precio o sin vela típica no se sugiere nada', () => {
  assert.equal(suggestEntry({ ...base, dir: null }), null);
  assert.equal(suggestEntry({ ...base, dir: 'down', priceY: null }), null);
  assert.equal(suggestEntry({ ...base, dir: 'down', unit: 0 }), null);
});

// ---------- Zona de entrada: dos líneas, y entre las dos está bien entrar ----------
test('zona de VENTA: mejor precio arriba (la orilla alta) y límite un poco por debajo del precio', () => {
  const z = suggestZone({ ...base, dir: 'down' });
  assert.equal(z.text, 'orilla alta');
  assert.equal(-z.bestRow, 106); // el máximo de la vela en curso
  assert.equal(-z.limitRow, 100 - BACK * 20); // 0.1 velas típicas al otro lado del precio
  assert.ok(z.bestRow < base.priceY && base.priceY < z.limitRow, 'el precio de la señal queda dentro de la zona');
});

test('zona de COMPRA: mejor precio abajo (la orilla baja) y límite un poco por encima del precio', () => {
  const z = suggestZone({ ...base, dir: 'up' });
  assert.equal(z.text, 'orilla baja');
  assert.equal(-z.bestRow, 92); // el mínimo de la vela en curso
  assert.equal(-z.limitRow, 100 + BACK * 20);
  assert.ok(z.limitRow < base.priceY && base.priceY < z.bestRow);
  assert.equal(suggestZone({ ...base, dir: null }), null);
});

// ---------- En el marcador: la zona se dibuja y la señal se mide desde el precio de la señal ----------
const row = (price) => -price;
const UP = chain([3, -2, 4, -3, 3, -2, 4, -3, 3, 4]); // señal ARRIBA; la vela en curso va de 106 a 112
const tally = (s) => [s.live.wins, s.live.losses, s.live.ties];
const read = (t, price, now) => t.update({ candles: UP, priceY: row(price), now, cycleMs: 5000, payout: 85, manual: true, suggest: true });

test('la señal trae su zona de dos líneas y el precio de la señal queda dentro', () => {
  const t = createTimedTracker();
  t.predict();
  const s = read(t, 112, 0);
  assert.equal(s.signal.dir, 'up');
  assert.ok(s.entry && s.entry.zone, 'la señal trae su zona');
  assert.equal(s.entry.kind, 'zona');
  assert.equal(s.entry.text, 'orilla baja');
  assert.equal(s.entry.filled, true); // la entrada de referencia es la del momento de la señal
  assert.equal(s.entry.row, row(112));
  // Compra: la línea del mejor precio queda por debajo del precio (fila mayor) y la límite, por encima.
  assert.ok(s.entry.zone.best > row(112) && s.entry.zone.limit < row(112));
  assert.equal(s.entry.inZone, true);
});

test('avisa cuando el precio se sale de la zona (por cualquiera de las dos líneas)', () => {
  const t = createTimedTracker();
  t.predict();
  let s = read(t, 112, 0);
  const best = -s.entry.zone.best;
  const limit = -s.entry.zone.limit;
  s = read(t, (best + 112) / 2, 1000); // a mitad de camino hacia la orilla: dentro
  assert.equal(s.entry.inZone, true);
  s = read(t, limit + 1, 2000); // se fue a favor, más allá de la línea límite: fuera
  assert.equal(s.entry.inZone, false);
  s = read(t, best - 1, 3000); // pasó la orilla en contra: fuera
  assert.equal(s.entry.inZone, false);
});

test('con zona, la señal se mide desde el precio de la señal (la línea de referencia)', () => {
  let t = createTimedTracker();
  t.predict();
  read(t, 112, 0);
  let s = read(t, 114, 5000);
  assert.deepEqual(tally(s), [1, 0, 0]);
  assert.equal(s.lastResult, 'acertó');
  t = createTimedTracker();
  t.predict();
  read(t, 112, 0);
  s = read(t, 110, 5000);
  assert.deepEqual(tally(s), [0, 1, 0]);
});

test('sin pedir zona de entrada el marcador sigue igual que siempre', () => {
  const t = createTimedTracker();
  t.predict();
  let s = t.update({ candles: UP, priceY: row(112), now: 0, cycleMs: 5000, payout: 85, manual: true });
  assert.equal(s.entry, null);
  s = t.update({ candles: UP, priceY: row(115), now: 5000, cycleMs: 5000, payout: 85, manual: true });
  assert.deepEqual(tally(s), [1, 0, 0]);
});
