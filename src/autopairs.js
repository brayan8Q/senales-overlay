/**
 * LOS PARES SE CAMBIAN SOLOS (16 nov 2026).
 *
 * El usuario: «tú puedes estarle cambiando las divisas… siempre tener una divisa que sí esté a la altura». Medido
 * ese dia: el pago de un par OTC cambia en minutos (QAR/CNY 92 → 40 %, GBP/JPY 92 → 80 %, USD/PKR 92 → 44 %), y con
 * una lista fija de cuatro pares el bot se quedaba con uno o dos donde entrar.
 *
 * Cada lugar (1 a 4) tiene un par. Si ese par lleva `afterMs` pagando menos del minimo —o el bot ya no lo tiene—
 * se cambia por el mejor pagado que no este en otro lugar. Entre los que pagan igual se prefieren los pares
 * conocidos (`PREFERRED`), para que no acabe en monedas raras si no hace falta.
 */
const PREFERRED = ['EUR/USD OTC', 'AUD/CAD OTC', 'AUD/USD OTC', 'EUR/CHF OTC', 'CHF/JPY OTC', 'GBP/USD OTC', 'USD/CAD OTC', 'EUR/JPY OTC', 'AUD/CHF OTC', 'CAD/CHF OTC', 'GBP/JPY OTC', 'USD/JPY OTC', 'EUR/GBP OTC', 'CAD/JPY OTC', 'AUD/JPY OTC', 'USD/CHF OTC', 'CHF/NOK OTC'];
const keyOf = (name) => String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const rank = (name) => {
  const at = PREFERRED.findIndex((p) => keyOf(p) === keyOf(name));
  return at < 0 ? PREFERRED.length : at;
};

/**
 * @param {{slots:string[], offers:Array<{name:string,payout:number}>, minPayout:number, low:number[], now:number, afterMs?:number}} input
 *   slots = el par de cada lugar; offers = lo que paga ahora cada par que el bot sigue; low = por lugar, desde
 *   cuando paga poco (0 = esta bien) — se devuelve actualizado.
 * @returns {{slots:string[], low:number[], changes:Array<{index:number, from:string, to:string, was:number|null, pays:number}>}}
 */
function reviewPairs({ slots, offers, minPayout, low, now, afterMs = 20000 }) {
  const pays = new Map(offers.map((o) => [keyOf(o.name), o]));
  const next = [...slots];
  const since = [...low];
  const changes = [];
  const ranked = [...offers].filter((o) => o.payout >= minPayout).sort((a, b) => b.payout - a.payout || rank(a.name) - rank(b.name) || String(a.name).localeCompare(String(b.name)));
  for (let i = 0; i < next.length; i++) {
    if (!next[i]) {
      since[i] = 0;
      continue; // un lugar vacio lo dejo vacio el usuario
    }
    const offer = pays.get(keyOf(next[i]));
    if (offer && offer.payout >= minPayout) {
      since[i] = 0;
      continue;
    }
    if (!since[i]) since[i] = now;
    if (now - since[i] < afterMs) continue;
    const taken = new Set(next.map(keyOf));
    const better = ranked.find((o) => !taken.has(keyOf(o.name)));
    if (!better) continue; // no hay con que cambiarlo: se queda (y no se opera mientras pague poco)
    changes.push({ index: i, from: next[i], to: better.name, was: offer ? offer.payout : null, pays: better.payout });
    next[i] = better.name;
    since[i] = 0;
  }
  return { slots: next, low: since, changes };
}

module.exports = { reviewPairs, PREFERRED };
