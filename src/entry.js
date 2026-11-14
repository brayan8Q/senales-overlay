/**
 * Entrada sugerida: a que precio conviene entrar una vez que sale la senal.
 *
 * En una VENTA (ABAJO) gana quien entra mas ARRIBA: la operacion acierta si el precio termina
 * por debajo de la entrada. En una COMPRA (ARRIBA), al reves: conviene entrar mas ABAJO. Por
 * eso la entrada no se sugiere en el precio del instante, sino un poco en contra de la senal,
 * esperando a que el precio llegue a la linea:
 *
 *   - Zona: desde el precio de la senal hasta la ORILLA, que es el extremo de la vela en curso
 *     de ese lado (su maximo en una venta, su minimo en una compra). Nunca mas lejos de 0.6
 *     velas tipicas (no llegaria) ni mas cerca de 0.25 (no mejoraria nada).
 *   - Si en este instante el precio VIENE hacia la orilla (sube en una venta, baja en una
 *     compra), se espera en la ORILLA: viene solo.
 *   - Si va a favor de la senal o esta quieto, se espera a MEDIA zona: pedirle la orilla
 *     entera seria quedarse casi siempre sin entrar.
 *
 * Es una regla, no una garantia: si el precio se va a favor sin regresar, no hay entrada. El
 * panel mide por separado cuantas veces se entro y cuantas de esas acertaron.
 */
const MIN_EDGE = 0.25; // la orilla queda al menos a esto del precio (en velas tipicas)
const MAX_EDGE = 0.6; // y como mucho a esto
const KIND_TEXT = { down: { orilla: 'orilla alta', media: 'media zona' }, up: { orilla: 'orilla baja', media: 'media zona' } };

/**
 * @param {object} input
 * @param {'up'|'down'} input.dir       Lado de la senal.
 * @param {number} input.priceY         Fila del precio en este instante (menor = mas arriba).
 * @param {{high:number, low:number}} input.forming  Vela en curso (numero mayor = precio mas alto).
 * @param {number} input.unit           Rango de una vela tipica (mismas unidades que las velas).
 * @param {{vote:number}} [input.momentum]  Movimiento del precio ahora mismo (+ sube, - baja).
 * @returns {{ row:number, kind:'orilla'|'media', text:string, distance:number }|null}
 */
function suggestEntry({ dir, priceY, forming, unit, momentum = null }) {
  if ((dir !== 'up' && dir !== 'down') || priceY === null || !forming || !(unit > 0)) return null;
  const sign = dir === 'down' ? 1 : -1; // venta: se entra mas arriba (precio mayor); compra: mas abajo
  const price = -priceY;
  const extreme = dir === 'down' ? forming.high : forming.low;
  const room = Math.max(0, (extreme - price) * sign); // lo que hay hasta el extremo de la vela de ese lado
  const edge = Math.min(MAX_EDGE * unit, Math.max(MIN_EDGE * unit, room));
  const vote = momentum ? momentum.vote || 0 : 0;
  const coming = vote * sign > 0; // el precio viene hacia la orilla
  const kind = coming ? 'orilla' : 'media';
  const distance = kind === 'orilla' ? edge : edge / 2;
  return { row: -(price + sign * distance), kind, text: KIND_TEXT[dir][kind], distance };
}

/**
 * ZONA de entrada: dos lineas, y entre las dos esta bien entrar (como "4180 - 4174" en una senal).
 *
 *   - Linea del MEJOR precio (la orilla): mas arriba que el precio en una venta, mas abajo en
 *     una compra. Es el extremo de la vela en curso de ese lado, entre 0.25 y 0.6 velas tipicas.
 *   - Linea LIMITE: un poco al otro lado del precio de la senal (0.15 velas tipicas). Pasada esa
 *     linea el precio ya se fue a favor: entrar ahi es perseguirlo.
 *
 * El precio de la senal queda siempre DENTRO de la zona: se puede entrar al momento, y cuanto
 * mas cerca de la orilla, mejor precio.
 * @returns {{ bestRow:number, limitRow:number, text:string }|null}
 */
const BACK = 0.15; // la linea limite queda a esto del precio de la senal (en velas tipicas)
function suggestZone({ dir, priceY, forming, unit }) {
  // La orilla es la misma que la de la entrada de una sola linea cuando el precio viene hacia ella.
  const edge = suggestEntry({ dir, priceY, forming, unit, momentum: { vote: dir === 'down' ? 1 : -1 } });
  if (!edge) return null;
  const sign = dir === 'down' ? 1 : -1;
  return { bestRow: edge.row, limitRow: priceY + sign * Math.max(1, BACK * unit), text: edge.text };
}

module.exports = { suggestEntry, suggestZone, MIN_EDGE, MAX_EDGE, BACK };
