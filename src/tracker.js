/**
 * Marcador honesto de la senal, modo "por vela".
 *
 * Cada vez que cierra una vela se guarda la senal para la vela siguiente. Al
 * cerrar esa vela se anota si la senal acerto (la vela fue del color dicho),
 * fallo o empato. Nada de esto apuesta dinero: solo mide.
 *
 * Para saber cuando cerro una vela se comparan las velas cerradas de una
 * lectura con las ya conocidas (colores y tamanos relativos), asi no importa
 * que la grafica se desplace o cambie de escala. Cada vela se califica una
 * sola vez, aunque deje de verse un momento y vuelva a aparecer.
 */
const { signalFor, MIN_CANDLES } = require('./signal');
const { summarize } = require('./score');

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] || 1;
};

const body = (c) => Math.abs(c.close - c.open);
const range = (c) => c.high - c.low;

/** True si dos tramos de velas son las mismas velas (aunque cambie la escala). */
function sameCandles(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) if (a[i].dir !== b[i].dir) return false;
  const scaleA = median(a.map(range));
  const scaleB = median(b.map(range));
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff += Math.abs(body(a[i]) / scaleA - body(b[i]) / scaleB);
    diff += Math.abs(range(a[i]) / scaleA - range(b[i]) / scaleB);
  }
  return diff / (a.length * 2) < 0.2;
}

/**
 * Cuantas velas nuevas cerraron entre lo ya conocido (`known`) y una lectura.
 *   k > 0  -> cerraron k velas nuevas
 *   k = 0  -> nada nuevo
 *   k < 0  -> la lectura trae |k| velas MENOS al final (una vela dejo de verse un
 *             momento, p. ej. tapada por un globo de la plataforma): nada nuevo
 *   null   -> no se pueden empatar (otro activo, zoom, desplazamiento)
 */
function closedSince(known, cur) {
  for (const k of [0, 1, -1, 2, -2, 3]) {
    const knownEnd = known.length + Math.min(0, k); // velas conocidas que deberian verse
    const curEnd = cur.length - Math.max(0, k); // velas de la lectura que ya se conocian
    const length = Math.min(8, knownEnd, curEnd);
    if (length < 4) continue;
    if (sameCandles(known.slice(knownEnd - length, knownEnd), cur.slice(curEnd - length, curEnd))) return k;
  }
  return null;
}

/** Huella de una vela que no depende de la escala: su forma y la de la anterior. */
function identity(list, index) {
  const shape = (c) => (c ? c.dir + ':' + Math.round((10 * body(c)) / (range(c) || 1)) : '-');
  const current = list[index];
  const previous = list[index - 1];
  const ratio = previous ? Math.round((10 * range(current)) / (range(previous) || 1)) : 0;
  return shape(previous) + '|' + shape(current) + '|' + ratio;
}

/** Marcador de la senal sobre una lista de velas cerradas (repaso de lo visible). */
function backtest(completed) {
  const score = { wins: 0, losses: 0, ties: 0 };
  for (let i = MIN_CANDLES - 1; i < completed.length - 1; i++) {
    const signal = signalFor(completed.slice(0, i + 1));
    if (!signal.dir) continue;
    const actual = completed[i + 1].dir;
    if (actual === 'flat') score.ties++;
    else if (actual === signal.dir) score.wins++;
    else score.losses++;
  }
  return score;
}

function createTracker() {
  const live = { wins: 0, losses: 0, ties: 0 };
  let known = null; // velas cerradas ya conocidas
  let pending = null; // senal vigente (para la vela en curso)
  let lastResult = '';
  let lastScored = null; // huella de la ultima vela calificada (para no repetirla)

  function score(signal, candle) {
    if (!signal || !signal.dir) return;
    if (candle.dir === 'flat') {
      live.ties++;
      lastResult = 'empate';
    } else if (candle.dir === signal.dir) {
      live.wins++;
      lastResult = 'acertó';
    } else {
      live.losses++;
      lastResult = 'falló';
    }
  }

  return {
    /**
     * Procesa una lectura de la grafica (todas las velas, la ultima en curso).
     * @returns {{ status: string, signal: object|null, live: object, visible: object, candles: number, lastResult: string }}
     */
    update(candles, payoutPercent) {
      if (candles.length < 3) {
        known = null;
        pending = null;
        return {
          status: 'no-chart',
          signal: null,
          candles: candles.length,
          lastResult,
          live: summarize(live, payoutPercent),
          visible: summarize({ wins: 0, losses: 0, ties: 0 }, payoutPercent),
        };
      }
      const completed = candles.slice(0, -1);
      let status = 'ok';

      if (!known) {
        known = completed;
        pending = signalFor(completed);
      } else {
        const k = closedSince(known, completed);
        if (k === null) {
          // La grafica cambio (zoom, desplazamiento, otro activo): se empieza de nuevo sin anotar nada.
          status = 'resync';
          known = completed;
          pending = signalFor(completed);
        } else if (k > 0) {
          // Cerraron k velas: se califica la senal que habia y se calcula la siguiente.
          for (let j = 0; j < k; j++) {
            const index = completed.length - k + j;
            const id = identity(completed, index);
            if (id !== lastScored) {
              score(pending, completed[index]);
              lastScored = id;
            }
            pending = signalFor(completed.slice(0, index + 1));
          }
          known = completed;
        }
        // k <= 0: nada nuevo; se conserva lo conocido.
      }

      return {
        status,
        signal: pending,
        candles: candles.length,
        lastResult,
        live: summarize(live, payoutPercent),
        visible: summarize(backtest(completed), payoutPercent),
      };
    },

    reset() {
      live.wins = 0;
      live.losses = 0;
      live.ties = 0;
      lastResult = '';
      lastScored = null;
    },
  };
}

module.exports = { createTracker, closedSince, backtest, sameCandles };
