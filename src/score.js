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

module.exports = { summarize, wilsonLow };
