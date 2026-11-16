/**
 * LA ULTIMA VELA (15 nov 2026, tarde). Medido en vivo ese dia: la senal salia al abrir la vela
 * nueva, pero a las IA se les preguntaba en el segundo 10 de 15 y contestaban en 1.4 s: decidian
 * viendo dos tercios de la ultima vela. En 19 de 37 senales, un tercio o mas del tamano de esa vela
 * se hizo despues de la consulta, y 9 cambiaron de color (esas acertaron 50 %; las otras, 70 %).
 * Dos remedios, los dos aqui:
 *   - PREGUNTAR TARDE (`askMoment`): la consulta sale cuando a la vela le faltan pocos segundos.
 *   - CONFIRMAR CON LA VELA CERRADA (`candleSeen` + `candleChange`): se guarda de que color iba la
 *     vela cuando se pregunto y, al salir la senal, se mira como quedo. Si cambio de color, lo que
 *     dijo la IA ya no vale.
 */
const TOLERANCE_MS = 1500;

/** Hora en que empezo la vela en curso segun el reloj, o null. */
function startOf(clock, now) {
  if (!clock || !clock.known) return null;
  if (Number.isFinite(clock.startedAt)) return clock.startedAt;
  return Number.isFinite(clock.elapsedMs) ? now - clock.elapsedMs : null;
}

/**
 * Lo que se le ensena a la IA de la vela en curso, para poder comprobar despues si cambio.
 * @param {Array<{dir:string, time?:number}>} candles  Velas (la ultima en curso).
 * @param {{known:boolean, seconds?:number, startedAt?:number, elapsedMs?:number}|null} clock
 * @returns {{time:number|null, startedAt:number|null, periodMs:number, dir:string}|null}
 */
function candleSeen(candles, clock, now) {
  const forming = candles && candles.length ? candles[candles.length - 1] : null;
  if (!forming) return null;
  return {
    time: Number.isFinite(forming.time) ? forming.time : null, // con la fuente interna: la hora de la vela
    startedAt: startOf(clock, now),
    periodMs: clock && clock.known && clock.seconds ? clock.seconds * 1000 : 0,
    dir: forming.dir || 'flat',
  };
}

/**
 * Como esta ahora la vela que se le enseno a la IA: la misma vela, todavia en curso o ya cerrada.
 * @returns {{changed:boolean, was:string, now:string, closed:boolean}|null}  null = ya no se puede
 *          ubicar esa vela (pasaron varias, o no hay reloj): no se comprueba nada.
 */
function candleChange(seen, candles, clock, now) {
  if (!seen || !candles || !candles.length) return null;
  let index = -1;
  if (seen.time !== null) {
    // La misma vela por su hora: es la que esta en curso o la que acaba de cerrar.
    for (let i = candles.length - 1; i >= 0 && i >= candles.length - 2; i--) {
      if (candles[i].time === seen.time) {
        index = i;
        break;
      }
    }
  } else if (seen.startedAt !== null && seen.periodMs > 0) {
    const start = startOf(clock, now);
    if (start === null) return null;
    const steps = Math.round((start - seen.startedAt) / seen.periodMs);
    if (steps < 0 || steps > 1 || Math.abs(start - seen.startedAt - steps * seen.periodMs) > TOLERANCE_MS) return null;
    index = candles.length - 1 - steps;
  }
  if (index < 0 || !candles[index]) return null;
  const dir = candles[index].dir || 'flat';
  return {
    changed: seen.dir !== 'flat' && dir !== 'flat' && dir !== seen.dir,
    was: seen.dir,
    now: dir,
    closed: index < candles.length - 1,
  };
}

/**
 * Cuando preguntar a las IA.
 * @param {object} input
 * @param {string} input.phase        Fase del panel ('analysis' = se esta analizando).
 * @param {number} input.thinking     Martingala en analisis (su nivel), o 0.
 * @param {number} input.remainingMs  Lo que le queda a la fase (analisis, o espera de la martingala).
 * @param {number|null} input.clockLeftMs  Lo que le falta a la vela en curso si la senal sale al
 *        abrir la siguiente y hay reloj; null si no.
 * @param {number} input.leadMs       Con cuanta anticipacion se pregunta.
 * @returns {{untilSignal:number|null, tooEarly:boolean}}  untilSignal = cuanto falta para que salga
 *          la senal, si se sabe; tooEarly = todavia no toca preguntar.
 */
function askMoment({ phase, thinking = 0, remainingMs = 0, clockLeftMs = null, leadMs }) {
  let untilSignal = null;
  if (phase === 'analysis') {
    if (thinking) untilSignal = remainingMs;
    // Analisis sincronizado con la vela: termina justo antes de que abra la siguiente. (Si el
    // analisis fuera a terminar antes de ese momento, no esta sincronizado: se pregunta ya.)
    else if (Number.isFinite(clockLeftMs) && clockLeftMs - leadMs < remainingMs) untilSignal = clockLeftMs;
  }
  return { untilSignal, tooEarly: untilSignal !== null && untilSignal > leadMs };
}

module.exports = { candleSeen, candleChange, askMoment, TOLERANCE_MS };
