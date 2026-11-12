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

    const complete = candles.length >= usual - MISSING_ALLOWED;
    const last = candles[candles.length - 1];
    const forming = priceY === null || Math.abs(priceY - -last.close) <= PRICE_TOLERANCE_PX;
    let reason = null;
    if (!complete) reason = `Un aviso de la plataforma tapa ${usual - candles.length} velas: espero a que se quite`;
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
 * el mismo numero de velas y, una por una, el mismo color y la misma forma (cuerpo y rango
 * respecto a lo normal). Se compara la FORMA y no los pixeles, porque la grafica se desplaza
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
function sameRead(a, b) {
  if (a.length !== b.length || b.length < 3) return false;
  const closedA = a.slice(0, -1); // la ultima (en curso) cambia a cada instante: no se compara
  const closedB = b.slice(0, -1);
  const scaleA = typicalRange(closedA);
  const scaleB = typicalRange(closedB);
  for (let i = 0; i < closedB.length; i++) {
    if (closedA[i].dir !== closedB[i].dir) return false;
    const range = Math.abs((closedA[i].high - closedA[i].low) / scaleA - (closedB[i].high - closedB[i].low) / scaleB);
    const body = Math.abs(Math.abs(closedA[i].close - closedA[i].open) / scaleA - Math.abs(closedB[i].close - closedB[i].open) / scaleB);
    if (range > SHAPE_TOLERANCE || body > SHAPE_TOLERANCE) return false;
  }
  return true;
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
