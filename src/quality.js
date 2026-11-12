/**
 * Control de calidad de la lectura.
 *
 * La plataforma dibuja cosas ENCIMA de la grafica justo cuando se opera: el aviso
 * "Trade closed" tapa varias velas y el globo del resultado ("+$1.65 ✓") tapa la
 * vela en curso. Con una lectura asi el panel tomaria una vela vieja por la actual.
 *
 * Aqui solo se DETECTA que partes de la lectura son de fiar; quien decide que hacer
 * es main.js. (Una primera version bloqueaba todo mientras hubiera algo tapado, y en
 * uso real eso dejo sin calificar todas las senales: al operar siempre hay algo encima.)
 *
 *   - forming:  la linea del precio pasa por el cierre de la ultima vela leida. Es
 *               cierto siempre para la vela en curso de verdad; si no coincide, la
 *               ultima vela leida no es la actual (esta tapada).
 *   - complete: no faltan de golpe varias velas respecto a lo que se venia viendo.
 */
const MEMORY_MS = 10000; // cuanto tiempo se recuerda cuantas velas se veian
const MISSING_ALLOWED = 2; // velas de menos que se toleran (salen por la izquierda, un globo viejo...)
const PRICE_TOLERANCE_PX = 5; // distancia maxima entre la linea del precio y el cierre de la vela en curso

function createQualityGate() {
  let seen = []; // { time, count }

  const inspect = (candles, priceY, now) => {
    seen = seen.filter((s) => now - s.time <= MEMORY_MS);
    const usual = seen.length ? Math.max(...seen.map((s) => s.count)) : 0;
    seen.push({ time: now, count: candles.length });
    if (candles.length < 3) return { forming: true, complete: true, reason: null }; // sin grafica: eso ya lo avisa el lector

    // Hueco en medio: las velas van una tras otra, a la misma distancia. Si entre dos hay sitio
    // para otra, algo la tapa (el aviso "Trade order placed", por ejemplo) y el historial
    // quedaria corrido si se diera la lectura por buena.
    let hole = 0;
    if (candles.length >= 5 && candles[0].x0 !== undefined) {
      const steps = [];
      for (let i = 1; i < candles.length; i++) steps.push(candles[i].x0 - candles[i - 1].x0);
      const pitch = [...steps].sort((a, b) => a - b)[Math.floor((steps.length - 1) / 2)];
      if (pitch > 0) for (const step of steps) if (step > pitch * 1.6) hole += Math.round(step / pitch) - 1;
    }
    const complete = candles.length >= usual - MISSING_ALLOWED && hole === 0;
    const last = candles[candles.length - 1];
    const forming = priceY === null || Math.abs(priceY - -last.close) <= PRICE_TOLERANCE_PX;
    let reason = null;
    if (hole) reason = `Un aviso de la plataforma tapa ${hole} ${hole === 1 ? 'vela' : 'velas'} en medio: espero a que se quite`;
    else if (!complete) reason = `Un aviso de la plataforma tapa ${usual - candles.length} velas: espero a que se quite`;
    else if (!forming) reason = 'Algo tapa la vela actual (globo de resultado u operación): espero a que se quite';
    return { forming, complete, reason };
  };

  return {
    /** Detalle: { forming, complete, reason }. */
    inspect,
    /** @returns {string|null}  null si la lectura es buena del todo; si no, por que no lo es. */
    check: (candles, priceY, now) => inspect(candles, priceY, now).reason,
    reset() {
      seen = [];
    },
  };
}

/**
 * Lectura verificada: las velas cerradas deben salir iguales en varias lecturas seguidas:
 * una por una, contando desde la mas reciente, el mismo color y la misma forma (cuerpo y
 * rango respecto a lo normal). Se compara la FORMA y no los pixeles, porque la grafica se desplaza
 * y cambia de escala todo el tiempo sin que eso sea un error.
 * Una sola lectura puede salir rara (un destello, algo que pasa por encima, una vela a medio
 * tapar); tres iguales seguidas, no.
 */
const VERIFY_READS = 3;
const SHAPE_TOLERANCE = 0.25; // diferencia admitida, en tamanos de vela tipica
const typicalRange = (candles) => {
  const sorted = candles.map((c) => c.high - c.low).sort((x, y) => x - y);
  return sorted[Math.floor((sorted.length - 1) / 2)] || 1;
};
/**
 * Compara las velas cerradas de dos lecturas, alineadas por la DERECHA (por la vela mas
 * reciente), que es donde esta lo que importa.
 *   shift = 0: no cerro ninguna vela entre las dos lecturas.
 *   shift = 1: entre las dos cerro una vela: todas se corrieron un lugar.
 * La vela del borde izquierdo no se compara (se ve cortada mientras sale de la zona) y se
 * admite una vela de mas o de menos por ese lado. Asi el seguimiento no se suelta cada vez
 * que cierra una vela ni cuando una sale por la izquierda.
 */
function aligned(closedA, closedB, shift) {
  const endB = closedB.length - shift;
  if (Math.abs(closedA.length - endB) > 1) return false;
  const count = Math.min(closedA.length, endB) - 1; // sin la del borde izquierdo
  if (count < 2) return false;
  const partA = closedA.slice(closedA.length - count);
  const partB = closedB.slice(endB - count, endB);
  const scaleA = typicalRange(partA);
  const scaleB = typicalRange(partB);
  for (let i = 0; i < count; i++) {
    if (partA[i].dir !== partB[i].dir) return false;
    const range = Math.abs((partA[i].high - partA[i].low) / scaleA - (partB[i].high - partB[i].low) / scaleB);
    const body = Math.abs(Math.abs(partA[i].close - partA[i].open) / scaleA - Math.abs(partB[i].close - partB[i].open) / scaleB);
    if (range > SHAPE_TOLERANCE || body > SHAPE_TOLERANCE) return false;
  }
  return true;
}
/** a = lectura anterior, b = lectura mas nueva. */
function sameRead(a, b) {
  if (a.length < 4 || b.length < 4) return false;
  const closedA = a.slice(0, -1); // la ultima (en curso) cambia a cada instante: no se compara
  const closedB = b.slice(0, -1);
  return aligned(closedA, closedB, 0) || aligned(closedA, closedB, 1);
}
function createStabilityCheck() {
  let recent = [];
  return {
    /** Anota una lectura y dice si coincide con las anteriores. */
    check(candles) {
      recent = [...recent, candles].slice(-VERIFY_READS);
      if (recent.length < VERIFY_READS) return false;
      const latest = recent[recent.length - 1];
      return recent.slice(0, -1).every((older) => sameRead(older, latest));
    },
    reset() {
      recent = [];
    },
  };
}

module.exports = { createQualityGate, createStabilityCheck, sameRead, PRICE_TOLERANCE_PX, MISSING_ALLOWED };
