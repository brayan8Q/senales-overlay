/**
 * EL PAR DE LA GRÁFICA, SOLO (16 nov 2026).
 *
 * El usuario cambia de par en la gráfica de Pocket sin tocar el panel. Para que el bot entre en el
 * par que él tiene a la vista, el panel lo reconoce por el precio: el que se lee del eje de la
 * pantalla (exacto a menos de 1 pip, medido contra sus operaciones) se compara con el precio de
 * ahora de todos los pares que sigue el bot. Aquí solo está la elección (sin efectos, se prueba);
 * quien la usa (main.js) pide dos coincidencias seguidas y deja que la fuente interna confirme
 * después por la forma de las velas.
 */
const { assetKey } = require('./feed');

/** Cuánto pueden diferir pantalla y bot para ser el mismo par: 3 pips, o 0.025 % en pares de precio alto. */
const pairTolerance = (price, pip) => Math.max(3 * (pip || 0.0001), Math.abs(price) * 0.00025);

/**
 * @param {{rows:Array, quote:{value:number,pip:number}, current:string, tried:Map<string,number>, now:number, stuck:boolean}} input
 *   rows = [[símbolo, nombre, precio, edad en s, pago]] del bot; current = lo escrito en «Activo»;
 *   tried = pares ya probados (símbolo -> cuándo); stuck = el par puesto lleva rato sin cuadrar.
 * @returns {{pick:Array|null, near:number, same:boolean}} pick = el par al que cambiar (null = quedarse).
 */
function pickChartPair({ rows, quote, current, tried, now, stuck }) {
  const tol = pairTolerance(quote.value, quote.pip);
  const near = rows
    .filter((r) => Array.isArray(r) && typeof r[0] === 'string' && Number.isFinite(r[2]) && Number(r[3]) <= 5 && Math.abs(r[2] - quote.value) <= tol)
    .sort((a, b) => Math.abs(a[2] - quote.value) - Math.abs(b[2] - quote.value));
  const want = assetKey(current);
  const isCurrent = (r) => Boolean(want) && (assetKey(r[0]) === want || assetKey(r[1]) === want);
  // El par escrito va al mismo precio que la pantalla: no es otro par (salvo que lleve rato sin
  // cuadrar y haya otro igual de cerca: entonces se prueba el otro).
  if (near.some(isCurrent) && !(stuck && near.length > 1)) return { pick: null, near: near.length, same: true };
  const fresh = near.filter((r) => !isCurrent(r) && !(tried.has(r[0]) && now - tried.get(r[0]) < 60000));
  return { pick: fresh[0] || null, near: near.length, same: false };
}

module.exports = { pairTolerance, pickChartPair };
