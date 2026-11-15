/**
 * Figuras de varias velas (sobre velas ya cerradas).
 *
 *   De giro (apuntan contra lo que venia pasando):
 *     - Doble techo / doble piso: el precio llego dos veces a la misma altura y no la paso.
 *     - Estrella de la tarde / de la manana: vela grande, vela chiquita (indecision) y vela
 *       grande en contra que recupera mas de la mitad de la primera.
 *   De continuacion (apuntan a favor):
 *     - Tres soldados / tres cuervos: tres velas seguidas del mismo color, cada una cerrando
 *       mas alla que la anterior, con cuerpo de verdad.
 *
 * Son simetricas: la misma grafica volteada da la figura contraria.
 *
 * Aviso honesto: estas figuras se describieron para velas de horas o dias. En velas de
 * segundos aparecen muy seguido y no hay prueba de que funcionen igual; por eso su efecto se
 * mide con el marcador, como todo lo demas.
 */
const LOOKBACK = 20; // velas en las que se busca el doble techo / doble piso
const RECENT = 6; // el segundo techo debe ser de las ultimas velas

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] || 1;
};
const body = (c) => Math.abs(c.close - c.open);
const mid = (c) => (c.open + c.close) / 2;

/** La misma lista volteada (lo que subia baja): sirve para escribir cada figura una sola vez. */
const flip = (candles) =>
  candles.map((c) => ({ dir: c.dir === 'up' ? 'down' : c.dir === 'down' ? 'up' : 'flat', open: -c.open, close: -c.close, high: -c.low, low: -c.high }));

/** Tres soldados: tres verdes seguidas, cada una cerrando mas arriba, con cuerpo de verdad. */
function threeSoldiers(candles, unit) {
  const last = candles.slice(-3);
  if (last.length < 3) return false;
  return last.every((c) => c.dir === 'up' && body(c) >= unit * 0.35) && last[1].close > last[0].close && last[2].close > last[1].close;
}

/** Estrella de la tarde: verde grande, vela chiquita arriba, roja que cierra bajo la mitad de la primera. */
function eveningStar(candles, unit) {
  const [a, b, c] = candles.slice(-3);
  if (!c) return false;
  if (a.dir !== 'up' || body(a) < unit * 0.6) return false;
  if (body(b) > body(a) * 0.35) return false;
  if (Math.min(b.open, b.close) < a.close - body(a) * 0.25) return false; // la chiquita queda arriba, cerca del cierre
  return c.dir === 'down' && body(c) >= body(a) * 0.5 && c.close <= mid(a);
}

/** Doble techo: dos maximos a la misma altura, con una baja clara en medio, y el precio ya girando. */
function doubleTop(candles, unit) {
  const list = candles.slice(-LOOKBACK);
  const n = list.length;
  if (n < 7) return false;
  const tops = [];
  for (let i = 2; i < n - 1; i++) {
    const around = [list[i - 2], list[i - 1], list[i + 1], list[i + 2]].filter(Boolean);
    if (around.every((c) => list[i].high >= c.high)) tops.push(i);
  }
  // Maximos pegados (a dos velas o menos) son el mismo techo: se juntan.
  const peaks = [];
  for (const i of tops) {
    const lastPeak = peaks[peaks.length - 1];
    if (lastPeak && i - lastPeak.end <= 2) {
      lastPeak.end = i;
      lastPeak.high = Math.max(lastPeak.high, list[i].high);
    } else peaks.push({ start: i, end: i, high: list[i].high });
  }
  if (peaks.length < 2) return false;
  const second = peaks[peaks.length - 1];
  const first = peaks[peaks.length - 2];
  if (second.end < n - RECENT || second.start - first.end < 3) return false;
  const h1 = first.high;
  const h2 = second.high;
  if (Math.abs(h1 - h2) > unit * 0.25) return false;
  const valley = Math.min(...list.slice(first.end + 1, second.start).map((c) => c.low));
  if (valley > Math.min(h1, h2) - unit) return false; // entre los dos techos tuvo que bajar al menos una vela
  const after = list.slice(second.end + 1);
  if (after.some((c) => c.high > h2 + unit * 0.1)) return false; // lo rompio hacia arriba: ya no es techo
  return list[n - 1].close <= h2 - unit * 0.4; // ya se separo del techo
}

const FIGURES = [
  // [detector, nombre alcista (grafica volteada), nombre bajista, votos, tipo]
  { test: doubleTop, down: 'doble techo', up: 'doble piso', votes: 2, kind: 'reverse' },
  { test: eveningStar, down: 'estrella de la tarde', up: 'estrella de la mañana', votes: 2, kind: 'reverse' },
  { test: threeSoldiers, down: 'tres cuervos', up: 'tres soldados', votes: 1, kind: 'follow', followsUp: true },
];

/**
 * Busca una figura en las velas cerradas (la ultima, la mas reciente).
 * @returns {{ name:string, vote:number, kind:'follow'|'reverse', text:string }|null}
 *   vote: + hacia arriba, - hacia abajo. kind: 'reverse' = figura de giro, 'follow' = de continuacion.
 */
function findFormation(candles) {
  if (!candles || candles.length < 3) return null;
  const unit = median(candles.slice(-LOOKBACK).map((c) => c.high - c.low));
  const mirrored = flip(candles);
  for (const figure of FIGURES) {
    // Los detectores estan escritos para un lado; el otro se obtiene volteando la grafica.
    const direct = figure.test(candles, unit);
    const inverse = figure.test(mirrored, unit);
    if (!direct && !inverse) continue;
    // Si la figura sale hacia los dos lados a la vez (mercado de lado), no dice nada.
    if (direct && inverse) continue;
    // doubleTop y eveningStar detectan la figura BAJISTA en la grafica tal cual; threeSoldiers, la ALCISTA.
    const up = figure.followsUp ? direct : !direct;
    const name = up ? figure.up : figure.down;
    return {
      name,
      vote: (up ? 1 : -1) * figure.votes,
      kind: figure.kind,
      text: `${name} (${figure.kind === 'reverse' ? 'giro' : 'continuación'} hacia ${up ? 'arriba' : 'abajo'})`,
    };
  }
  return null;
}

// ---------- PATRON de una senal (15 nov 2026) ----------
// Cada senal se clasifica segun la situacion de la grafica que la disparo, para medir despues
// cuales patrones aciertan de verdad (ver patternStats en score.js). Se mira en este orden:
//
//   reversa     La senal va CONTRA una vertical reciente (2+ velas grandes que marcaron extremo,
//               ver rebound.js) o contra una escalera de velas: apuesta al regreso.
//   rompimiento La senal va A FAVOR de una vertical (persiguiendola, o tras romper la base que
//               le siguio), o el precio esta mas alla de todo lo visto en las 20 velas previas.
//   rechazo     La vela en curso o la ultima cerrada toco el extremo de las ultimas 20 y dejo una
//               mecha larga (la mitad o mas de su rango); la senal se aleja de ese extremo.
//   tendencia   Escalera: de las ultimas 4 velas cerradas, 3 o mas son del color de la senal y
//               van haciendo maximos y minimos cada vez mas altos (o mas bajos).
//   rango       Las ultimas 10 velas caben en 4 velas tipicas y casi no avanzaron, o el color
//               cambio 5 o mas veces en 8 velas.
//   otro        Nada de lo anterior.
//
// Aviso honesto: son definiciones practicas, no leyes; por eso lo que cuenta es lo medido.
const { findVertical, antiRebound } = require('./rebound');

const PATTERNS = {
  rompimiento: 'rompimiento',
  rechazo: 'rechazo en extremo',
  tendencia: 'tendencia / escalera',
  reversa: 'reversa / capitulación',
  rango: 'rango / chop',
  otro: 'otro',
};
const PATTERN_KEYS = Object.keys(PATTERNS);
const colorOf = (c) => (c.dir === 'up' || c.dir === 'down' ? c.dir : c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat');

/** Escalera hacia arriba en las ultimas 4 velas cerradas. */
function staircaseUp(closed) {
  const last = closed.slice(-4);
  if (last.length < 4) return false;
  const greens = last.filter((c) => colorOf(c) === 'up').length;
  let steps = 0;
  for (let i = 1; i < last.length; i++) if (last[i].high > last[i - 1].high && last[i].low > last[i - 1].low) steps++;
  return greens >= 3 && steps >= 2;
}

/**
 * Patron de una senal hacia `dir`.
 * @param {{candles:Array, dir:'up'|'down'|null}} input  Velas (la ultima en curso) y lado de la senal.
 * @returns {{key:string, text:string, detail:string}}
 */
function patternOf({ candles, dir }) {
  const as = (key, detail = '') => ({ key, text: PATTERNS[key], detail });
  if (!dir || !candles || candles.length < 10) return as('otro');
  // Se escribe una sola vez, para una senal hacia ARRIBA: si es hacia abajo, se voltea la grafica.
  const list = dir === 'up' ? candles : flip(candles);
  const closed = list.slice(0, -1);
  const forming = list[list.length - 1];
  const unit = median(closed.slice(-LOOKBACK).map((c) => c.high - c.low));

  // 1) Vertical reciente.
  const vertical = findVertical(list);
  if (vertical) {
    if (vertical.dir === 'down') return as('reversa', `contra una vertical de ${vertical.length} velas`);
    const check = antiRebound({ candles: list, dir: 'up' });
    if (check.veto) return as('rompimiento', `persigue una vertical de ${vertical.length} velas`);
    if (check.allowed === 'base') return as('rompimiento', 'rompió la base que siguió a una vertical');
    if (check.allowed === 'pullback') return as('tendencia', 'retroceso superficial y confirmación tras una vertical');
    // 'profundo': el precio ya devolvio buena parte; se sigue con las reglas de abajo.
  }

  // 2) Rechazo en extremo: mecha larga en el minimo de las ultimas 20 (la senal sube desde ahi).
  for (const index of [list.length - 1, list.length - 2]) {
    const c = list[index];
    const before = list.slice(Math.max(0, index - LOOKBACK), index);
    if (!c || before.length < 8) continue;
    const range = c.high - c.low;
    const wick = Math.min(c.open, c.close) - c.low;
    if (c.low <= Math.min(...before.map((b) => b.low)) && range >= unit * 0.5 && wick >= range * 0.5) {
      return as('rechazo', 'mecha larga en el extremo de 20 velas');
    }
  }

  // 3) Escalera a favor (tendencia) o en contra (reversa).
  if (staircaseUp(closed)) return as('tendencia', 'escalera de velas a favor');
  if (staircaseUp(flip(closed))) return as('reversa', 'contra una escalera de velas');

  // 4) Rompimiento: el precio esta por encima de todo lo visto en las 20 velas previas a la ultima cerrada.
  const prior = closed.slice(-(LOOKBACK + 1), -1);
  if (prior.length >= 8 && forming.close > Math.max(...prior.map((c) => c.high))) return as('rompimiento', 'precio fuera del rango de 20 velas');

  // 5) Rango / chop.
  const ten = closed.slice(-10);
  if (ten.length >= 8) {
    const span = Math.max(...ten.map((c) => c.high)) - Math.min(...ten.map((c) => c.low));
    const net = Math.abs(ten[ten.length - 1].close - ten[0].open);
    const eight = closed.slice(-8).map(colorOf);
    let changes = 0;
    for (let i = 1; i < eight.length; i++) if (eight[i] !== eight[i - 1]) changes++;
    if ((span <= unit * 4 && net <= unit * 1.5) || changes >= 5) return as('rango', changes >= 5 ? 'velas alternadas' : 'precio encerrado');
  }
  return as('otro');
}

module.exports = { findFormation, threeSoldiers, eveningStar, doubleTop, flip, patternOf, PATTERNS, PATTERN_KEYS };
