/**
 * MARCA DE UNA OPERACIÓN ABIERTA (15 nov 2026).
 *
 * Cuando el usuario pone una operación, la plataforma dibuja junto a la vela en curso una marca
 * blanca: un triangulito (▲ compra, ▼ venta) y el monto ("▼ $1"). Con operaciones de segundos no
 * hay la línea larga de las operaciones de un minuto: solo esa marca. Sirve para saber EN QUÉ
 * MOMENTO entró el usuario, y contar el plazo de la señal desde ahí (no desde que salió la señal).
 *
 * Aquí solo se cuentan los píxeles blancos junto a la vela en curso, cerca del precio. Medido en
 * 60 imágenes reales del panel (13 nov 2026): sin operación abierta hay 0; con una marca, entre
 * 28 y 39; con dos, 73. El globo del resultado (que también trae letras blancas) no cuenta: se
 * descuenta lo que cae dentro de cada globo detectado.
 *
 * Quien llama decide si "apareció" una marca comparando con la cuenta de un momento antes.
 */
const WHITE = 225; // un pixel es blanco si sus tres colores llegan a esto
// La marca queda en la columna del momento de la entrada: sobre la vela en curso o, si justo
// cambio la vela, sobre la anterior. Por eso se mira desde una vela y pico a la izquierda.
const LEFT_CANDLES = 1.4; // cuanto se mira a la izquierda de la vela en curso, en anchos de vela
const RIGHT_CANDLES = 0.6; // y a su derecha (al menos 30 px)
const RIGHT_MIN = 30;
const REACH = 60; // y arriba / abajo de la fila del precio
const BADGE_HALF_WIDTH = 48; // medio ancho y medio alto del globo de resultado, desde su centro
const BADGE_HALF_HEIGHT = 16;
// Blancos de más que hacen falta para decir "apareció una marca": una sola trae 28 o más.
const MARK_MIN = 18;

/**
 * @param {Uint8Array|Buffer} rgba  Imagen de la zona.
 * @param {{x0:number, x1:number, row:number, badges?:Array<{x:number,y:number}>}} where
 *        Columnas de la vela en curso, fila del precio y globos de resultado detectados.
 * @returns {number|null}  Píxeles blancos junto a la vela (null si no se sabe dónde mirar).
 */
function countOrderMark(rgba, width, height, { x0, x1, row, badges = [] }) {
  if (![x0, x1, row].every(Number.isFinite)) return null;
  const candle = Math.max(8, x1 - x0 + 1);
  const left = Math.max(0, Math.round(x0 - candle * LEFT_CANDLES));
  const right = Math.min(width - 1, Math.round(x1 + Math.max(RIGHT_MIN, candle * RIGHT_CANDLES)));
  const top = Math.max(0, Math.round(row) - REACH);
  const bottom = Math.min(height - 1, Math.round(row) + REACH);
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const p = (y * width + x) * 4;
      if (rgba[p] < WHITE || rgba[p + 1] < WHITE || rgba[p + 2] < WHITE) continue;
      if (badges.some((b) => Math.abs(x - b.x) <= BADGE_HALF_WIDTH && Math.abs(y - b.y) <= BADGE_HALF_HEIGHT)) continue;
      count++;
    }
  }
  return count;
}

module.exports = { countOrderMark, MARK_MIN };
