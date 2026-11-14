/**
 * Reloj de la vela en curso: cuando abrio, cuanto lleva y cuanto le falta para cerrar.
 *
 * El panel no recibe la hora de las velas: solo ve la pantalla. El reloj se pone en hora cada vez
 * que se VE cerrar una vela (lectura verificada). Si llega la hora de cierre y no se pudo ver
 * (un globo de la plataforma tapa la grafica justo entonces), el cierre se da por el reloj, para
 * que el seguimiento, la espera de PREDECIR y la calificacion no se queden colgados.
 *
 * La duracion de la vela se toma de la memoria del mercado si ya la sabe; si no, se mide aqui
 * con dos cierres seguidos que caigan en el mismo tamano de catalogo (15 s, 30 s, 1 min...).
 */
const PERIODS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900]; // tamanos de vela posibles, en segundos
const GRACE_MS = 1200; // pasado el cierre esperado sin verlo, se da por cerrado
const MAX_INFERRED = 3; // cierres seguidos dados por reloj; despues el reloj se declara desconocido
const DUPLICATE_PART = 0.5; // un cierre visto a menos de media vela de uno dado por reloj es el mismo

/** Tamano de catalogo de un intervalo (segundos), o 0 si no se parece a ninguno. */
function periodOf(deltaMs) {
  for (const seconds of PERIODS) {
    if (Math.abs(deltaMs - seconds * 1000) <= Math.max(1500, seconds * 200)) return seconds;
  }
  return 0;
}

function createCandleClock() {
  let startedAt = 0; // cuando abrio la vela en curso (0 = no se sabe)
  let seen = []; // horas de los ultimos cierres vistos en la grafica
  let own = 0; // duracion medida aqui (segundos; 0 = todavia no)
  let lastBoundaryAt = 0;
  let lastInferred = false;
  let inferredRun = 0;

  const measure = () => {
    if (seen.length < 3) return;
    const a = periodOf(seen[seen.length - 1] - seen[seen.length - 2]);
    const b = periodOf(seen[seen.length - 2] - seen[seen.length - 3]);
    if (a && a === b) own = a;
  };

  return {
    /**
     * @param {object} input
     * @param {number} input.now       Reloj en milisegundos.
     * @param {boolean} input.closed   En esta lectura se vio cerrar una vela.
     * @param {number} [input.seconds] Duracion de la vela si ya se conoce por otro lado (0 = no).
     * @returns {{ known:boolean, seconds:number, startedAt:number, elapsedMs:number|null,
     *             remainingMs:number|null, closedNow:boolean, inferred:boolean }}
     *   known = se sabe cuando abrio la vela Y cuanto dura. closedNow = acaba de cerrar una vela
     *   (vista o dada por el reloj: `inferred`).
     */
    update({ now, closed = false, seconds = 0 }) {
      const duration = seconds || own;
      let closedNow = false;
      let inferred = false;
      if (closed) {
        const same = lastInferred && duration && now - lastBoundaryAt < duration * 1000 * DUPLICATE_PART;
        inferredRun = 0;
        if (!same) {
          // Cierre visto: el reloj se pone en hora.
          startedAt = now;
          lastBoundaryAt = now;
          lastInferred = false;
          closedNow = true;
          seen = [...seen, now].slice(-6);
          measure();
        }
        // Si es el mismo cierre que ya se habia dado por reloj, no se cuenta dos veces.
      } else if (startedAt && duration && now >= startedAt + duration * 1000 + GRACE_MS) {
        // Llego la hora y no se vio el cierre: se da por reloj.
        while (now >= startedAt + duration * 1000 + GRACE_MS) {
          startedAt += duration * 1000;
          inferredRun++;
        }
        if (inferredRun > MAX_INFERRED) {
          // Demasiado tiempo sin ver la grafica: ya no se puede asegurar en que vela se esta.
          startedAt = 0;
          inferredRun = 0;
          seen = [];
        } else {
          lastBoundaryAt = now;
          lastInferred = true;
          closedNow = true;
          inferred = true;
        }
      }
      const known = Boolean(startedAt && (seconds || own));
      const total = (seconds || own) * 1000;
      return {
        known,
        seconds: seconds || own,
        startedAt,
        elapsedMs: startedAt ? now - startedAt : null,
        remainingMs: known ? Math.max(0, total - (now - startedAt)) : null,
        closedNow,
        inferred,
      };
    },

    reset() {
      startedAt = 0;
      seen = [];
      own = 0;
      lastBoundaryAt = 0;
      lastInferred = false;
      inferredRun = 0;
    },
  };
}

module.exports = { createCandleClock, periodOf, GRACE_MS, MAX_INFERRED };
