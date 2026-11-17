// Las 4 graficas del panel (16 nov 2026): nombres de simbolo, reparto y zona de cada grafica.
const test = require('node:test');
const assert = require('node:assert');
const { symbolOf, gridBounds, zoomFor, zoneOf, SETUP_SCRIPT, switchScript, ZONE, PAGE_MIN } = require('../src/wall');

test('el nombre del par se pasa al simbolo de la terminal', () => {
  assert.strictEqual(symbolOf('EUR/USD OTC'), 'EURUSD_otc');
  assert.strictEqual(symbolOf('aud cad otc'), 'AUDCAD_otc');
  assert.strictEqual(symbolOf('GBP/JPY'), 'GBPJPY');
  assert.strictEqual(symbolOf(''), '');
});

test('la ventana se reparte en cuatro graficas que no se enciman ni se salen', () => {
  const grid = gridBounds(1281, 761);
  assert.strictEqual(grid.length, 4);
  for (const b of grid) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= 1281 && b.y + b.height <= 761);
  assert.ok(grid[0].x + grid[0].width < grid[1].x && grid[0].y + grid[0].height < grid[2].y);
});

test('la zona de una grafica queda dentro de su lienzo, sin el nombre del par ni los ejes', () => {
  const zone = zoneOf({ x: 8, y: 31 }, { x: 642, y: 382 }, [0, 0, 638, 378]);
  assert.deepStrictEqual(zone, { x: 8 + 642 + ZONE.left, y: 31 + 382 + ZONE.top, width: 638 - ZONE.left - ZONE.right, height: 378 - ZONE.top - ZONE.bottom });
  assert.strictEqual(zoneOf({ x: 0, y: 0 }, { x: 0, y: 0 }, [0, 0, 100, 60]), null); // demasiado chica
  assert.strictEqual(zoneOf({ x: 0, y: 0 }, { x: 0, y: 0 }, null), null);
});

test('los guiones de la pagina son codigo valido y no tocan compra ni venta', () => {
  assert.doesNotThrow(() => new Function(`return ${SETUP_SCRIPT}`));
  assert.doesNotThrow(() => new Function(switchScript('EURUSD_otc')));
  assert.ok(!/btn-call|btn-put|buy|sell/i.test(SETUP_SCRIPT.replace(/\.control-wrap/g, '')));
  assert.match(switchScript('EURUSD_otc'), /po-td-asset/);
});

test('una grafica chica se reduce para que la pagina quepa entera, y su zona se pasa a puntos de pantalla', () => {
  const zoom = zoomFor({ width: 650, height: 386 });
  assert.ok(650 / zoom >= PAGE_MIN.width - 1 && 386 / zoom >= PAGE_MIN.height - 1);
  assert.strictEqual(zoomFor({ width: 3000, height: 2000 }), 1);
  const zone = zoneOf({ x: 0, y: 0 }, { x: 100, y: 50 }, [0, 0, 1000, 700], 0.5);
  assert.deepStrictEqual(zone, { x: 100 + ZONE.left * 0.5, y: 50 + ZONE.top * 0.5, width: 500 - (ZONE.left + ZONE.right) * 0.5, height: 350 - (ZONE.top + ZONE.bottom) * 0.5 });
});
