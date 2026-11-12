/**
 * Historial largo de velas, acumulado lectura a lectura.
 *
 * En pantalla caben pocas velas (20 o 30). Para lecturas que piden mas historia
 * (EMA 50/200, niveles de soporte, tendencia larga) se va guardando cada vela
 * que cierra mientras el programa esta abierto. Cuando la grafica cambia de
 * escala o se desplaza, todo lo guardado se pasa a la escala nueva usando las
 * velas que siguen a la vista, asi el historial queda siempre en las mismas
 * unidades que la lectura actual (pixeles de la pantalla, mayor = mas alto).
 *
 * Tambien guarda el recorrido del precio de los ultimos minutos.
 *
 * Si la grafica deja de reconocerse durante varios segundos (otro activo, zoom
 * fuerte) el historial se empieza de nuevo: mezclar dos graficas seria inventar.
 */
const { closedSince } = require('./tracker');

const MAX_CANDLES = 60; // historial corto a proposito: lo viejo distrae de la vela actual
const PRICE_MEMORY_MS = 10 * 60 * 1000; // 10 min: para medir si el precio continua o rebota
const PRICE_STEP_MS = 250; // como mucho una lectura de precio cada 250 ms
const LOST_FRAMES_TO_RESET = 12; // lecturas seguidas sin reconocer la grafica antes de empezar de nuevo

/** Recta y = a*x + b que mejor ajusta a los pares [x, y]. */
function fit(pairs) {
  const n = pairs.length;
  const meanX = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanY = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pairs) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) * (x - meanX);
  }
  if (!den) return { a: 1, b: meanY - meanX };
  const a = num / den;
  return { a, b: meanY - a * meanX };
}

const copy = (c) => ({ dir: c.dir, open: c.open, close: c.close, high: c.high, low: c.low });

function createHistory() {
  let candles = []; // velas cerradas, la mas reciente al final
  let prices = []; // { time, value }
  let lost = 0;

  const transform = (a, b) => {
    const t = (v) => a * v + b;
    candles = candles.map((c) => ({ dir: c.dir, open: t(c.open), close: t(c.close), high: t(c.high), low: t(c.low) }));
    prices = prices.map((p) => ({ time: p.time, value: t(p.value) }));
  };

  const restart = (completed) => {
    candles = completed.map(copy);
    prices = [];
    lost = 0;
  };

  return {
    /**
     * @param {Array} all       Velas leidas en pantalla (la ultima en curso).
     * @param {number|null} priceY  Fila de la linea de precio.
     * @param {number} now      Reloj en milisegundos.
     * @returns {{ candles: Array, prices: Array, restarted: boolean }}
     */
    update(all, priceY, now) {
      const completed = all.slice(0, -1);
      let restarted = false;
      let rescaled = false; // la grafica cambio de escala o se desplazo en vertical
      let added = []; // velas que acaban de cerrar en esta lectura (para la memoria del mercado)
      if (completed.length >= 4) {
        if (!candles.length) {
          restart(completed);
        } else {
          const k = closedSince(candles, completed);
          if (k === null) {
            lost++;
            if (lost >= LOST_FRAMES_TO_RESET) {
              restart(completed);
              restarted = true;
            }
          } else {
            lost = 0;
            const knownEnd = candles.length + Math.min(0, k);
            const curEnd = completed.length - Math.max(0, k);
            const length = Math.min(knownEnd, curEnd);
            // Paso de la escala guardada a la de esta lectura, con las velas que se ven en las dos.
            const pairs = [];
            for (let i = 0; i < length; i++) {
              const old = candles[knownEnd - length + i];
              const cur = completed[curEnd - length + i];
              pairs.push([old.high, cur.high], [old.low, cur.low], [old.open, cur.open], [old.close, cur.close]);
            }
            const { a, b } = fit(pairs);
            if (!(a > 0.1 && a < 10)) {
              restart(completed);
              restarted = true;
            } else {
              if (Math.abs(a - 1) > 0.003 || Math.abs(b) > 0.4) {
                transform(a, b);
                rescaled = true;
              }
              // Lo que esta a la vista se toma de la lectura actual (salvo la vela del borde
              // izquierdo, que puede verse cortada).
              for (let i = 1; i < length; i++) candles[knownEnd - length + i] = copy(completed[curEnd - length + i]);
              // Si al alejar el zoom se ven velas mas viejas que las guardadas, se agregan al principio.
              if (curEnd > knownEnd) candles = [...completed.slice(1, curEnd - knownEnd).map(copy), ...candles];
              if (k > 0) {
                added = completed.slice(-k).map(copy);
                candles.push(...added);
              }
              if (candles.length > MAX_CANDLES) candles = candles.slice(-MAX_CANDLES);
            }
          }
        }
      }

      prices = prices.filter((p) => now - p.time <= PRICE_MEMORY_MS);
      if (priceY !== null && candles.length && lost === 0) {
        const lastPrice = prices[prices.length - 1];
        if (!lastPrice || now - lastPrice.time >= PRICE_STEP_MS) prices.push({ time: now, value: -priceY });
      }
      // Mientras no se reconoce la grafica, lo guardado no esta en la escala de esta lectura:
      // se devuelve solo lo que se ve.
      if (lost > 0) return { candles: completed, prices: [], restarted, rescaled: true, added: [] };
      return { candles, prices, restarted, rescaled: rescaled || restarted, added };
    },

    reset() {
      candles = [];
      prices = [];
      lost = 0;
    },
  };
}

module.exports = { createHistory, fit };
