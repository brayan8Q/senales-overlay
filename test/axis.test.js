/** Lectura del eje de precios: números, escala en pips y precio actual. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { readAxis, readLabels, fitScale, findGridLines, labelOffset, pipSize } = require('../src/axis');
const { readCandles, findPriceLine } = require('../src/candles');
const { computeReadings } = require('../src/readings');
const { chain } = require('./helpers');

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const numbers = (png) =>
  readLabels(png.data, png.width, png.height)
    .map((l) => l.text)
    .filter((t) => /^\d+\.\d+$/.test(t));
function priceNow(png) {
  const candles = readCandles(png.data, png.width, png.height);
  const priceY = findPriceLine(png.data, png.width, png.height, -candles[candles.length - 1].close);
  const axis = readAxis(png.data, png.width, png.height);
  return axis.at(priceY).toFixed(axis.decimals);
}

test('captura real (5 decimales): lee los números del eje, la escala y el precio actual', () => {
  const png = load('eje_real.png');
  assert.deepEqual(numbers(png), ['1.22000', '1.21500', '1.21000', '1.20000']);
  const axis = readAxis(png.data, png.width, png.height);
  assert.equal(axis.labels, 4);
  assert.equal(axis.decimals, 5);
  assert.equal(axis.pip, 0.0001);
  assert.equal(axis.anchored, true);
  // 0.005 de precio cada ~133.7 px -> 0.374 pips por pixel
  assert.ok(Math.abs(axis.perPixel / axis.pip - 0.374) < 0.003, String(axis.perPixel / axis.pip));
  // La etiqueta de la plataforma decía 1.20573
  assert.ok(Math.abs(Number(priceNow(png)) - 1.20573) <= 0.00002, priceNow(png));
});

test('captura real de USD/MXN (4 decimales, con 4, 6 y 8)', () => {
  const png = load('eje_usdmxn.png');
  assert.deepEqual(numbers(png), ['18.6400', '18.6200', '18.6000']);
  const axis = readAxis(png.data, png.width, png.height);
  assert.equal(axis.decimals, 4);
  assert.equal(axis.anchored, true);
  // La etiqueta de la plataforma decía 18.6455
  assert.ok(Math.abs(Number(priceNow(png)) - 18.6455) <= 0.0002, priceNow(png));
});

test('el número del eje va dibujado arriba de su línea de cuadrícula: se corrige ese desfase', () => {
  const png = load('eje_real.png');
  const grid = findGridLines(png.data, png.width, png.height);
  for (const row of [32, 165, 299, 434, 568]) assert.ok(grid.includes(row), `falta la línea ${row}: ${grid}`);
  const scale = fitScale(readLabels(png.data, png.width, png.height));
  const offset = labelOffset(scale, grid);
  assert.ok(offset >= 15 && offset <= 16.5, String(offset));
  // Sin cuadrícula no se puede anclar: hay pips, pero no precio
  assert.equal(labelOffset(scale, []), null);
});

test('sin eje a la vista no hay escala (el panel sigue en "velas")', () => {
  for (const name of ['grafica_real.png', 'grafica_real3.png', 'grafica_real4.png']) {
    const png = load(name);
    assert.equal(readAxis(png.data, png.width, png.height), null, name);
  }
});

test('la escala solo se acepta si los números van a pasos iguales', () => {
  const label = (y, text) => ({ y, text });
  // Tres números en línea recta
  const ok = fitScale([label(10, '1.22000'), label(110, '1.21500'), label(210, '1.21000')]);
  assert.equal(ok.labels, 3);
  assert.ok(Math.abs(ok.perPixel - 0.00005) < 1e-9);
  // Uno mal leído (1.27500 en vez de 1.21500) se descarta y quedan los otros dos
  const outlier = fitScale([label(10, '1.22000'), label(110, '1.27500'), label(210, '1.21000'), label(310, '1.20500')]);
  assert.equal(outlier.labels, 3);
  // Solo dos números y el paso no es "redondo": no se confía
  assert.equal(fitScale([label(10, '1.22000'), label(110, '1.21370')]), null);
  // Solo dos, con paso redondo: vale
  assert.equal(fitScale([label(10, '1.22000'), label(110, '1.21500')]).labels, 2);
  // Precios que suben hacia abajo: imposible
  assert.equal(fitScale([label(10, '1.21000'), label(110, '1.21500')]), null);
  // Texto que no es un número
  assert.equal(fitScale([label(10, '1?.2'), label(110, 'M10')]), null);
});

test('tamaño del pip según los decimales', () => {
  assert.equal(pipSize(5), 0.0001); // 1.20573
  assert.equal(pipSize(4), 0.0001); // 18.6455
  assert.equal(pipSize(3), 0.01); // 153.123
  assert.equal(pipSize(2), 0.01);
});

test('con la escala del eje, las lecturas salen en pips', () => {
  // Dos caídas hasta ~90 con rebote, y el precio cerca del soporte
  const candles = chain([-3, -4, -3, 4, 4, 3, -4, -4, -3, 4, 3, 4, -3, -3, -4]);
  const time = Date.UTC(2026, 10, 11, 13);
  const prices = Array.from({ length: 61 }, (_, i) => ({ time: time - (60 - i) * 1000, value: 100 + (i % 2 ? 4 : -4) }));
  const input = { candles: candles.slice(0, -1), forming: candles[candles.length - 1], time, prices };
  const key = (r, k) => r.items.find((i) => i.key === k);

  const plain = computeReadings(input);
  assert.match(key(plain, 'move').text, /^±[\d.]+ velas$/);
  assert.match(key(plain, 'level').text, /velas$/);

  // 1 pixel = 0.5 pips
  const inPips = computeReadings({ ...input, pips: { perPixel: 0.00005, pip: 0.0001 } });
  assert.equal(key(inPips, 'move').text, '±2 pips'); // osciló ±4 px
  assert.match(key(inPips, 'level').text, /^[\d.]+ pips$/);
  assert.match(key(inPips, 'level').detail, /Soporte a [\d.]+ pips por debajo \(2 toques\)/);
  assert.equal(inPips.data.movimiento_ultimo_minuto.oscilacion_pips, 2);
  assert.equal(typeof inPips.data.soporte_abajo.distancia_pips, 'number');
  assert.equal(typeof inPips.data.vela_tipica_en_pips, 'number');
  // Los votos no cambian por la unidad
  assert.equal(inPips.vote, plain.vote);
});
