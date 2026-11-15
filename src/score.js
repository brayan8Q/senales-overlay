/**
 * Cuentas del marcador: porcentaje de aciertos, minimo necesario para no
 * perder con el pago de la plataforma, dinero simulado y veredicto.
 */

/** Limite inferior del intervalo de Wilson al 95 % para una proporcion. */
function wilsonLow(wins, n) {
  if (n === 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const center = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center - spread) / (1 + (z * z) / n);
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * @param {{wins:number, losses:number, ties:number}} score
 * @param {number} payoutPercent  Lo que paga la plataforma al acertar (p. ej. 85).
 */
function summarize({ wins, losses, ties }, payoutPercent) {
  const n = wins + losses;
  const hitRate = n ? (wins / n) * 100 : null;
  // Al fallar se pierde 1; al acertar se gana payout/100. Punto de equilibrio:
  const breakEven = (100 / (100 + payoutPercent)) * 100;
  const simulated = (wins * payoutPercent) / 100 - losses; // apostando 1 por senal

  let verdict;
  if (n < 30) {
    verdict = `Solo ${n} señales medidas: todavía no se puede concluir nada.`;
  } else if (hitRate < breakEven) {
    verdict = `Acierta ${round1(hitRate)} % y necesitaría ${round1(breakEven)} %: apostando así se pierde dinero.`;
  } else if (wilsonLow(wins, n) * 100 < breakEven) {
    verdict = `Va en ${round1(hitRate)} % (mínimo ${round1(breakEven)} %), pero con ${n} señales eso puede ser pura suerte.`;
  } else {
    verdict = `Lleva ${round1(hitRate)} % en ${n} señales, sobre el mínimo de ${round1(breakEven)} %. Una racha no garantiza que siga.`;
  }

  return {
    wins,
    losses,
    ties,
    hitRate: hitRate === null ? null : round1(hitRate),
    breakEven: round1(breakEven),
    simulated: Math.round(simulated * 100) / 100,
    verdict,
  };
}

// ---------- Estadistica por PATRON (15 nov 2026) ----------
// Cada operacion medida lleva el patron que la disparo (ver patternOf en formations.js), el pago
// de ese momento y su resultado. De las ultimas 100 de cada patron se saca: acierto (sin contar
// empates), P&L apostando 1 por operacion (+pago/100 al acertar, -1 al fallar) y el punto de
// equilibrio segun el pago PROMEDIO de esas operaciones.
// Auto-veto: un patron con 20 o mas operaciones decididas y acierto por debajo de su punto de
// equilibrio queda "desactivado por estadistica". Sigue midiendose en papel (sin mostrarse como
// senal), asi que si su acierto se recupera, se reactiva solo.
// Aviso honesto: con 20 operaciones el margen de error es de unos +-22 puntos; el veto con tan
// pocas puede apagar un patron por pura mala racha (y la medicion en papel lo puede devolver).
const PATTERN_WINDOW = 100;
const PATTERN_VETO_MIN = 20;

/** Acierto minimo (0..1) para no perder con un pago dado: se pierde 1 al fallar y se gana pago/100 al acertar. */
const breakEvenOf = (payoutPercent) => 100 / (100 + payoutPercent);

/**
 * @param {Array<{pattern:string, result:'win'|'loss'|'tie', payout:number}>} ops  De la mas vieja a la mas nueva.
 * @returns {Object<string,{pattern:string,n:number,wins:number,losses:number,ties:number,decided:number,
 *   accuracy:number|null,pnl:number,avgPayout:number|null,breakEven:number|null,vetoed:boolean}>}
 *   accuracy, avgPayout y breakEven en porcentaje (un decimal).
 */
function patternStats(ops, { window = PATTERN_WINDOW, vetoMin = PATTERN_VETO_MIN } = {}) {
  const groups = {};
  for (const op of ops || []) {
    if (!op || !op.pattern) continue;
    (groups[op.pattern] = groups[op.pattern] || []).push(op);
  }
  const out = {};
  for (const [pattern, list] of Object.entries(groups)) {
    const recent = list.slice(-window);
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pnl = 0;
    let paySum = 0;
    let payCount = 0;
    for (const op of recent) {
      const pay = Number.isFinite(op.payout) ? op.payout : null;
      if (pay !== null) {
        paySum += pay;
        payCount++;
      }
      if (op.result === 'win') {
        wins++;
        pnl += (pay === null ? 0 : pay) / 100;
      } else if (op.result === 'loss') {
        losses++;
        pnl -= 1;
      } else ties++;
    }
    const decided = wins + losses;
    const avgPayout = payCount ? paySum / payCount : null;
    const even = avgPayout === null ? null : breakEvenOf(avgPayout);
    const accuracy = decided ? wins / decided : null;
    out[pattern] = {
      pattern,
      n: recent.length,
      wins,
      losses,
      ties,
      decided,
      accuracy: accuracy === null ? null : round1(accuracy * 100),
      pnl: Math.round(pnl * 100) / 100,
      avgPayout: avgPayout === null ? null : round1(avgPayout),
      breakEven: even === null ? null : round1(even * 100),
      vetoed: decided >= vetoMin && even !== null && accuracy < even,
    };
  }
  return out;
}

module.exports = { summarize, wilsonLow, patternStats, breakEvenOf, PATTERN_WINDOW, PATTERN_VETO_MIN };
