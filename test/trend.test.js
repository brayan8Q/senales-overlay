/** Tendencia del modo por segundos: debe ver subidas y bajadas por igual. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readCandles } = require('../src/candles');
const { trendSignal, slope } = require('../src/signal');
const { generate } = require('./gen');
const { chain } = require('./helpers');

const candlesOf = (name) => {
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
  return readCandles(png.data, png.width, png.height);
};

test('pendiente de una serie', () => {
  assert.equal(slope([1, 2, 3, 4]), 1);
  assert.equal(slope([8, 6, 4, 2]), -2);
  assert.equal(slope([5, 5, 5]), 0);
});

test('lee la tendencia como se ve en las capturas reales', () => {
  // Sube fuerte y luego se queda de lado arriba: sin tendencia clara
  assert.equal(trendSignal(candlesOf('grafica_real.png')).dir, null);
  // Cae con fuerza en las últimas velas (incluida la que tapa el globo "$0")
  assert.equal(trendSignal(candlesOf('grafica_real2.png')).dir, 'down');
  // Venía cayendo y se está recuperando: ya va hacia arriba
  assert.equal(trendSignal(candlesOf('grafica_real3.png')).dir, 'up');
});

test('subidas y bajadas se tratan igual', () => {
  // Subida sostenida sin retrocesos: antes un freno por RSI la mandaba a ESPERAR
  assert.equal(trendSignal(chain([2, 3, 2, 4, 3, 2, 3, 4, 2, 3])).dir, 'up');
  assert.equal(trendSignal(chain([-2, -3, -2, -4, -3, -2, -3, -4, -2, -3])).dir, 'down');
  // Venía bajando y gira hacia arriba en las últimas velas
  assert.equal(trendSignal(chain([-4, -5, -3, -6, -4, -5, 6, 5, 4, 3])).dir, 'up');
  // De lado
  assert.equal(trendSignal(chain([2, -2, 2, -2, 2, -2, 2, -2, 2, -2])).dir, null);
  // Pocas velas
  assert.equal(trendSignal(chain([1, 2, 3])).dir, null);

  // La misma gráfica volteada da siempre la señal contraria
  const opposite = { up: 'down', down: 'up', null: null };
  for (let seed = 1; seed <= 40; seed++) {
    const candles = generate(seed, 30);
    const flipped = candles.map((c) => ({ ...c, open: -c.open, close: -c.close, high: -c.low, low: -c.high }));
    assert.equal(trendSignal(flipped).dir, opposite[trendSignal(candles).dir], `semilla ${seed}`);
  }
});

test('sobre precios al azar da tantas señales de subir como de bajar', () => {
  let up = 0;
  let down = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const all = generate(seed, 100);
    for (let n = 10; n <= 100; n++) {
      const dir = trendSignal(all.slice(Math.max(0, n - 20), n)).dir;
      if (dir === 'up') up++;
      else if (dir === 'down') down++;
    }
  }
  const share = up / (up + down);
  assert.ok(share > 0.47 && share < 0.53, `arriba ${(share * 100).toFixed(1)} %`);
});

test('patrón de la vela en curso', () => {
  const { candlePattern } = require('../src/signal');
  const candle = (open, close, high, low) => ({ open, close, high, low });

  assert.deepEqual(candlePattern(candle(100, 108, 109, 99)), { vote: 1, text: 'cuerpo fuerte verde' });
  assert.deepEqual(candlePattern(candle(108, 100, 109, 99)), { vote: -1, text: 'cuerpo fuerte rojo' });
  // Subió y lo regresaron: mecha larga arriba = rechazo (aunque la vela sea verde)
  assert.equal(candlePattern(candle(100, 102, 112, 99)).vote, -1);
  // Bajó y lo levantaron: mecha larga abajo = rebote
  assert.equal(candlePattern(candle(102, 100, 103, 90)).vote, 1);
  // Cuerpo mínimo con mechas parejas: indecisión
  assert.equal(candlePattern(candle(100, 100.5, 106, 94)).vote, 0);
  // Cuerpo mediano: no dice nada
  assert.equal(candlePattern(candle(100, 104, 108, 97)).vote, 0);
  // Envolventes: el cuerpo cubre al de la vela anterior, de color contrario
  assert.deepEqual(candlePattern(candle(98, 106, 110, 94), candle(104, 100, 105, 99)), { vote: 1, text: 'envolvente alcista' });
  assert.deepEqual(candlePattern(candle(106, 98, 110, 94), candle(100, 104, 105, 99)), { vote: -1, text: 'envolvente bajista' });
  // Sin vela o sin movimiento
  assert.equal(candlePattern(null).vote, 0);
  assert.equal(candlePattern(candle(100, 100, 100, 100)).vote, 0);

  // La misma vela volteada da el voto contrario
  const flip = (c) => ({ open: -c.open, close: -c.close, high: -c.low, low: -c.high });
  for (let seed = 1; seed <= 30; seed++) {
    const list = generate(seed, 12);
    for (let i = 1; i < list.length; i++) {
      const normal = candlePattern(list[i], list[i - 1]).vote;
      const mirrored = candlePattern(flip(list[i]), flip(list[i - 1])).vote;
      assert.equal(mirrored, normal === 0 ? 0 : -normal, `semilla ${seed}, vela ${i}`);
    }
  }
});

test('una vela ya muy estirada no vota y bloquea seguirla', () => {
  const { candlePattern } = require('../src/signal');
  const { decide } = require('../src/timed');
  const candle = (open, close, high, low) => ({ open, close, high, low });
  // Velas anteriores con cuerpos de 4 a 6 puntos
  const context = [[100, 104], [104, 99], [99, 105], [105, 101], [101, 106], [106, 102]].map(([o, c]) =>
    candle(o, c, Math.max(o, c) + 2, Math.min(o, c) - 2),
  );
  const previous = context[context.length - 1];

  // Vela verde de 14 puntos: casi 3 veces lo normal
  const bigUp = candlePattern(candle(102, 116, 117, 101), previous, context);
  assert.equal(bigUp.vote, 0);
  assert.equal(bigUp.blocks, 'up');
  assert.match(bigUp.text, /ya muy extendida hacia arriba/);
  // Lo mismo hacia abajo
  const bigDown = candlePattern(candle(102, 88, 103, 87), previous, context);
  assert.equal(bigDown.blocks, 'down');
  // Una vela de tamaño normal no bloquea nada
  assert.equal(candlePattern(candle(102, 107, 108, 101), previous, context).blocks, undefined);
  // Sin velas anteriores no se puede saber qué es "normal": se comporta como antes
  assert.equal(candlePattern(candle(102, 116, 117, 101), previous).blocks, undefined);

  // En la votación: aunque todo apunte hacia arriba, no se persigue la vela estirada...
  const up = { dir: 'up' };
  let d = decide(up, bigUp, ['up', 'up']);
  assert.equal(d.dir, null);
  assert.match(d.reason, /No se persigue una vela ya estirada/);
  // ...pero sí se puede dar señal en contra si el precio se da la vuelta con fuerza
  //    (la racha por tramos sola vale 2 votos contra 1 de las velas: todavía no alcanza)
  assert.equal(decide(up, bigUp, ['down', 'down', 'down']).dir, null);
  d = decide(up, bigUp, ['down', 'down', 'down'], { ticks: { vote: -2, text: 'bajando con fuerza', net: -6 } });
  assert.equal(d.dir, 'down');
  // Y hacia abajo igual
  assert.equal(decide({ dir: 'down' }, bigDown, ['down', 'down']).dir, null);
});

test('captura real con operación abierta: lee la vela en curso y no la persigue', () => {
  const { candlePattern } = require('../src/signal');
  const { decide } = require('../src/timed');
  // La plataforma dibuja una raya verde pegada a la vela actual mientras hay una operación abierta.
  const candles = candlesOf('grafica_real4.png');
  const last = candles[candles.length - 1];
  assert.equal(candles.length, 9, JSON.stringify(candles.map((c) => c.x0)));
  assert.equal(last.dir, 'up'); // la vela verde grande, no la roja anterior
  const widths = candles.map((c) => c.x1 - c.x0 + 1);
  assert.ok(Math.max(...widths) - Math.min(...widths) <= 3, JSON.stringify(widths));

  const pattern = candlePattern(last, candles[candles.length - 2], candles.slice(0, -1));
  assert.equal(pattern.blocks, 'up', pattern.text);
  // Con el precio subiendo y esa vela, antes daba ARRIBA; ahora espera.
  assert.equal(decide(trendSignal(candles), pattern, ['up']).dir, null);
  assert.equal(decide(trendSignal(candles), pattern, ['up', 'up', 'up']).dir, null);
});
