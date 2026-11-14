/**
 * Marcador honesto de la senal, modo "por segundos".
 *
 * Ciclo de tres pasos:
 *   1. ANALISIS: durante unos segundos solo se observa hacia donde se mueve el precio.
 *   2. SENAL: se da ARRIBA / ABAJO (o ESPERAR) y se anota el precio de ese instante.
 *   3. Pasados N segundos se mira si el precio quedo arriba o abajo y se califica.
 * En modo manual el ciclo arranca cuando el usuario pulsa PREDECIR y al terminar
 * se queda en reposo; en automatico vuelve solo al paso 1.
 *
 * El precio se lee como la posicion de la linea del precio actual RESPECTO a
 * unas velas cerradas de referencia (0 = su minimo, 1 = su maximo). Esas velas
 * ya no cambian de precio, asi que la medida sigue valiendo aunque la grafica
 * se desplace o cambie de escala. Solo si ya no se reconocen (zoom, otro
 * activo) el tramo queda sin medir.
 *
 * La senal es una votacion, tratando igual subidas y bajadas. Lo que mas pesa
 * es lo mas reciente:
 *   - Precio ahora mismo: lectura a lectura en los ultimos 3 segundos (hasta 2 votos).
 *   - Vela actual: su patron -cuerpo fuerte, mecha de rechazo, envolvente- (2 votos).
 *   - Precio por tramos: hacia donde se movio en los ultimos tramos (hasta 2 votos).
 *   - Velas: hacia donde van las ultimas, incluida la que esta en curso (1 voto).
 * Hacen falta al menos dos votos netos hacia el mismo lado. Si la vela actual
 * ya esta muy extendida no se da senal a su favor: el movimiento ya ocurrio.
 */
const { trendSignal, candlePattern, climax } = require('./signal');
const { findFormation } = require('./formations');
const { summarize } = require('./score');
const { sameCandles } = require('./tracker');
const { suggestZone } = require('./entry');

const REFERENCE_CANDLES = 4;
const VOTES_NEEDED = 2;
const TICK_WINDOW_MS = 3000; // ventana del movimiento "ahora mismo"
const TICK_MEMORY_MS = 6000; // lecturas que se guardan
const MAX_HOLD_MS = 5000; // en modo manual, cuanto mas se espera a la IA pasada la pausa
// Calificar con la grafica tapada: sirve una lectura buena de hasta 0.7 s antes del final de la
// senal, o la primera buena hasta 1.5 s despues. Pasados 4 s sin poder leer, queda sin calificar.
const SCORE_EARLY_MS = 700;
const SCORE_LATE_MS = 1500;
const SCORE_MAX_WAIT_MS = 4000;

// ---------- PREDECIR alineado con el cambio de vela (modo manual) ----------
// Al pulsar PREDECIR: si la vela en curso lleva abierta esto o menos (o menos de 1/3 de su
// duracion, lo que sea menor) se analiza y se predice ESA vela; si ya va mas avanzada, se
// espera a que abra la siguiente y ahi empieza el analisis.
const EARLY_CANDLE_MS = 8000;
// Mientras se espera la vela siguiente: si el precio deja de llegar durante este tiempo, se
// cancela y el panel vuelve a LISTO.
const PRICE_LOST_MS = 90000;
// FRENO para la IA: con cuantas velas cerradas seguidas del mismo color ya no se sigue ese lado.
const AI_STREAK_BRAKE = 4;
// Cuando NO sale prediccion (ESPERAR: ninguna lectura clara), no hay nada que medir durante todo
// el plazo: el panel se libera a este tiempo para poder pedir otra (con plazos cortos, al plazo).
const NO_SIGNAL_MS = 10000;
// Si todavia no se sabe cuanto dura la vela, solo se arranca recien visto un cierre.
const UNKNOWN_CANDLE_START_MS = 2000;

/** Precio relativo a un grupo de velas: 0 = su minimo, 1 = su maximo. */
function relativePrice(priceY, candles) {
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  const span = high - low || 1;
  return { value: (-priceY - low) / span, pixel: 1 / span };
}

/**
 * Velas de referencia de una lectura: las ultimas cerradas, dejando fuera la
 * mas reciente. Esa ultima es la que mas "baila" (a veces el lector la toma
 * por la vela en curso), asi que no sirve de apoyo.
 */
function pickReference(completed) {
  if (completed.length < REFERENCE_CANDLES + 1) return null;
  return completed.slice(-(REFERENCE_CANDLES + 1), -1);
}

/** Busca las velas de referencia en una lectura posterior (pueden haber cerrado velas nuevas). */
function findReference(reference, completed) {
  for (let shift = 0; shift <= 4; shift++) {
    const end = completed.length - shift;
    const segment = completed.slice(end - reference.length, end);
    if (segment.length === reference.length && sameCandles(reference, segment)) return segment;
  }
  return null;
}

/**
 * Busca un giro en las lecturas: el precio subio 3 px o mas desde la primera lectura hasta
 * un pico, y desde ahi ya bajo al menos un 35 % de lo subido (o lo mismo al reves, desde un piso).
 * @returns {{vote:number,text:string,net:number,turn:'up'|'down'}|null}
 */
function findTurn(samples) {
  const n = samples.length;
  if (n < 5) return null;
  const price = samples.map((t) => -t.y); // mayor = mas alto
  const last = price[n - 1];
  let peak = 0;
  let floor = 0;
  for (let i = 1; i < n; i++) {
    if (price[i] >= price[peak]) peak = i;
    if (price[i] <= price[floor]) floor = i;
  }
  const check = (index, sign) => {
    if (index === 0 || index > n - 3) return null; // hacen falta al menos 2 lecturas despues del extremo
    const run = (price[index] - price[0]) * sign; // lo que avanzo hasta el extremo
    const back = (price[index] - last) * sign; // lo que ya devolvio
    const bouncing = (last - price[n - 3]) * sign >= 1; // volvio a ir hacia el extremo
    if (run < 3 || back < Math.max(2, run * 0.35) || bouncing) return null;
    const down = sign > 0;
    return {
      vote: (down ? -1 : 1) * (back >= run * 0.5 ? 2 : 1),
      text: down ? 'giró hacia abajo desde el pico' : 'giró hacia arriba desde el piso',
      net: down ? -back : back,
      turn: down ? 'down' : 'up',
      index,
    };
  };
  const fromPeak = check(peak, 1);
  const fromFloor = check(floor, -1);
  const found = fromPeak && fromFloor ? (fromPeak.index > fromFloor.index ? fromPeak : fromFloor) : fromPeak || fromFloor;
  if (!found) return null;
  const { index, ...result } = found;
  return result;
}

/**
 * Como se esta moviendo el precio AHORA: lectura a lectura en los ultimos segundos.
 * @param {Array<{time:number, y:number}>} ticks  Filas de la linea de precio (y menor = mas arriba).
 * @returns {{ vote: number, text: string, net: number }}  net = pixeles recorridos (+ subio).
 */
function tickMomentum(ticks, now) {
  const recent = ticks.filter((t) => now - t.time <= TICK_WINDOW_MS);
  if (recent.length < 3) return { vote: 0, text: 'sin lecturas', net: 0 };

  // 1) Giro: el precio marco un pico (o un piso) hace un momento y ya devolvio buena parte.
  //    "Va subiendo" deja de ser cierto en cuanto se da la vuelta: esto se mira antes que nada.
  const turn = findTurn(ticks.filter((t) => now - t.time <= TICK_MEMORY_MS));
  if (turn) return turn;

  // 2) Frenando: avanzo en la primera mitad y casi nada en la segunda.
  const mid = Math.floor((recent.length - 1) / 2);
  const firstHalf = recent[0].y - recent[mid].y;
  const secondHalf = recent[mid].y - recent[recent.length - 1].y;
  if (recent.length >= 5 && Math.abs(firstHalf) >= 3 && firstHalf * secondHalf >= 0 && Math.abs(secondHalf) < Math.abs(firstHalf) * 0.25) {
    return { vote: 0, text: (firstHalf > 0 ? 'subía' : 'bajaba') + ', perdiendo fuerza', net: firstHalf + secondHalf, fading: true };
  }
  let ups = 0;
  let downs = 0;
  for (let i = 1; i < recent.length; i++) {
    const step = recent[i - 1].y - recent[i].y; // positivo = subio
    if (step > 0) ups++;
    else if (step < 0) downs++;
  }
  const net = recent[0].y - recent[recent.length - 1].y;
  if (Math.abs(net) < 1) return { vote: 0, text: 'quieto', net };
  const dir = net > 0 ? 1 : -1;
  const withMove = dir > 0 ? ups : downs;
  const against = dir > 0 ? downs : ups;
  // Con fuerza: recorrio 3 px o mas y casi todas las lecturas fueron en esa direccion.
  const strong = Math.abs(net) >= 3 && withMove >= against * 2 + 1;
  return {
    vote: dir * (strong ? 2 : 1),
    text: (dir > 0 ? 'subiendo' : 'bajando') + (strong ? ' con fuerza' : ''),
    net,
  };
}

/**
 * Votacion de la senal.
 * @param {{dir:'up'|'down'|null}} trend   Tendencia de las velas.
 * @param {{vote:number,text:string,blocks?:string}} pattern  Patron de la vela en curso.
 * @param {string[]} moves  Movimientos del precio por tramos ('up'|'down'|'flat'), el ultimo al final.
 * @param {object} [options]
 * @param {boolean} [options.force]  Dar siempre ARRIBA o ABAJO: si no hay dos votos, se elige
 *        el lado hacia el que se inclina lo poco que hay y se marca "confianza baja".
 * @param {'up'|'down'|null} [options.fallback]  Ultimo desempate (color de la vela en curso).
 * @param {{vote:number,text:string,net:number}} [options.ticks]  Movimiento del precio ahora mismo.
 * @param {{vote:number,text:string}} [options.context]  Resumen de las 8 lecturas (ver readings.js).
 * @param {{kind:string|null,vote:number,text:string}} [options.regime]  Patron medido en el precio
 *        real: si viene continuando o rebotando (ver regime.js).
 * @param {{vote:number,kind:string,text:string}} [options.formation]  Figura de varias velas (doble
 *        techo, estrella, tres soldados...; ver formations.js).
 * @param {{vote:number,text:string}} [options.memory]  Memoria del mercado: que paso otras veces en
 *        una situacion como esta (ver memory.js).
 * @returns {{ dir: 'up'|'down'|null, reason: string, votes: number, confidence: string }}
 */
function decide(trend, pattern, moves, { force = false, fallback = null, ticks = null, context = null, regime = null, memory = null, formation = null } = {}) {
  // Patron medido en el precio real (ver regime.js). Si en esta grafica el precio viene
  // CONTINUANDO, no tiene sentido apostar al regreso de una vela estirada: se quita el bloqueo.
  if (regime && regime.kind === 'continua' && pattern.blocks) {
    pattern = { ...pattern, blocks: undefined };
  }
  const sign = { up: 1, down: -1 };
  const opposite = { up: 'down', down: 'up' };
  const now = ticks || { vote: 0, text: 'sin lecturas', net: 0 };

  const trendVote = sign[trend.dir] || 0;
  const candleVote = pattern.vote * 2; // la vela en curso pesa doble

  const lastMove = moves.length ? moves[moves.length - 1] : 'flat';
  let streak = 0;
  if (lastMove !== 'flat') {
    for (let i = moves.length - 1; i >= 0 && moves[i] === lastMove; i--) streak++;
  }
  const moveVote = (sign[lastMove] || 0) * Math.min(streak, 2);

  // Contexto: resumen de las lecturas largas (tendencia, EMA, momentum, RSI, nivel). Hasta 2 votos.
  const contextVote = context ? Math.max(-2, Math.min(2, context.vote || 0)) : 0;

  // Agotamiento confirmado: la vela ya esta muy estirada Y el precio ya giro desde su extremo.
  // Es la lectura mas clara de "llego a su pico": pesa 2 votos mas hacia el regreso.
  const exhausted = Boolean(pattern.blocks) && now.turn === opposite[pattern.blocks];
  const exhaustionVote = exhausted ? -2 * sign[pattern.blocks] : 0;

  // Patron medido en el precio real. Las lecturas son de dos clases:
  //   - las que SIGUEN el movimiento (precio ahora, tramos, velas, vela actual, tendencia/EMA/momentum)
  //   - las que apuestan al REGRESO (vela estirada, agotamiento, RSI extremo, soporte/resistencia)
  // La simulacion mostro que cada clase acierta en un tipo de mercado y falla en el otro. Por eso:
  //   - patron 'continua': cuentan las que siguen (mas el voto del patron); las de regreso no.
  //   - patron 'rebota':   cuentan las de regreso (mas el voto del patron, contrario al ultimo tramo).
  //   - sin patron claro:  cuentan todas, como siempre.
  const kind = regime ? regime.kind : null;
  const clamp2 = (v) => Math.max(-2, Math.min(2, v || 0));
  const regimeVote = kind ? Math.max(-3, Math.min(3, regime.vote || 0)) : 0;
  const followers = trendVote + candleVote + now.vote + moveVote;
  const contextFollow = context ? clamp2(context.follow === undefined ? context.vote : context.follow) : 0;
  const contextReverse = context ? clamp2(context.reverse) : 0;
  const stretchedVote = pattern.blocks ? -2 * sign[pattern.blocks] : 0; // vela estirada -> regreso

  // Memoria del mercado: lo que paso las otras veces que esta grafica estuvo en una situacion
  // como la de ahora (p. ej. tras 3 velas verdes seguidas). Solo trae voto si hay casos suficientes.
  const memoryVote = memory ? clamp2(memory.vote) : 0;

  let votes;
  if (kind === 'continua') votes = followers + contextFollow + regimeVote;
  else if (kind === 'rebota') votes = regimeVote + contextReverse + stretchedVote + exhaustionVote;
  else votes = followers + contextVote + exhaustionVote;
  votes += memoryVote;
  // Figura de varias velas (ver formations.js). Las de giro no cuentan si el precio viene
  // continuando, ni las de continuacion si viene rebotando: se le cree mas a lo medido.
  const formationFits = Boolean(formation) && (!kind || (kind === 'continua') === (formation.kind === 'follow'));
  const formationVote = formationFits ? clamp2(formation.vote) : 0;
  votes += formationVote;
  const dir = votes >= VOTES_NEEDED ? 'up' : votes <= -VOTES_NEEDED ? 'down' : null;

  const trendText = trend.dir === 'up' ? 'hacia arriba' : trend.dir === 'down' ? 'hacia abajo' : 'de lado';
  const word = lastMove === 'up' ? 'arriba' : 'abajo';
  const streakText = streak >= 2 ? `, ${streak} tramos seguidos hacia ${word}` : '';
  const contextText = context ? ` · lecturas: ${context.text}` : '';
  const exhaustedText = exhausted ? 'Vela agotada: ya estirada y el precio giró desde su extremo. ' : '';
  const regimeText = (regime && regime.kind ? `Patrón medido: ${regime.text}. ` : '') + (memoryVote ? `Memoria: ${memory.text}. ` : '') + (formationVote ? `Figura: ${formation.text}. ` : '');
  const summary = `${regimeText}${exhaustedText}Precio ${now.text}${streakText} · vela actual: ${pattern.text} · velas ${trendText}${contextText}.`;

  // Las lecturas por separado, para mostrarlas en chiquito en el panel.
  const lean = (vote) => (vote > 0 ? 'up' : vote < 0 ? 'down' : 'flat');
  const readings = {
    trend: { text: trendText.replace('hacia ', ''), lean: lean(trendVote) },
    candle: { text: pattern.short || pattern.text, lean: lean(candleVote) },
    price: { text: now.text + (streak >= 2 ? ` (${streak} tramos)` : ''), lean: lean(now.vote + moveVote) },
  };

  // No se persigue una vela que ya se estiro demasiado (con patron de rebote ya voto arriba).
  if (dir && pattern.blocks === dir && kind !== 'rebota') {
    if (!force) {
      return { dir: null, votes, readings, confidence: 'ninguna', reason: `No se persigue una vela ya estirada. ${summary}` };
    }
    // Obligado a elegir: una vela muy estirada suele devolver parte del recorrido.
    return {
      dir: opposite[dir],
      votes,
      readings,
      confidence: 'baja',
      reason: `Confianza baja: vela ya estirada, posible regreso. ${summary}`,
    };
  }
  if (dir) {
    return { dir, votes, readings, confidence: Math.abs(votes) >= 4 ? 'alta' : 'media', reason: summary };
  }
  if (!force) return { dir, votes, readings, confidence: 'ninguna', reason: `No coinciden: ${summary}` };

  // Obligado a elegir sin dos votos: se sigue lo poco que haya, de lo mas reciente a lo mas viejo.
  let forced = votes > 0 ? 'up' : votes < 0 ? 'down' : null;
  if (!forced && pattern.blocks) forced = opposite[pattern.blocks];
  // Con patron de rebote, lo poco que haya se toma al reves: contra lo que venia haciendo el precio.
  if (!forced && kind === 'rebota' && followers !== 0) forced = followers > 0 ? 'down' : 'up';
  if (!forced && now.net !== 0) forced = now.net > 0 ? 'up' : 'down';
  if (!forced && lastMove !== 'flat') forced = lastMove;
  if (!forced) forced = trend.dir || fallback || 'up';
  return { dir: forced, votes, readings, confidence: 'baja', reason: `Confianza baja, sin ventaja clara: ${summary}` };
}

function createTimedTracker() {
  const live = { wins: 0, losses: 0, ties: 0 };
  let pending = null; // senal vigente: { dir, mark, time, info }
  let watching = null; // analisis en curso: { mark, time }
  let observed = false; // ya hubo un analisis desde la ultima senal
  let armed = false; // modo manual: el usuario pidio una prediccion
  // PREDECIR alineado: esperando a que abra la vela siguiente.
  //   { since, lastPriceAt, closeAt }  closeAt = cuando abrio la vela que se puede predecir (null = aun no)
  let waiting = null;
  let moves = []; // movimientos del precio por tramos
  let ticks = []; // lecturas recientes de la linea de precio: { time, value, reference }
  let lastGood = null; // ultima lectura buena: { time, priceY, completed }
  let lastResult = '';

  /**
   * Marca el precio de ahora. De dos maneras, la que se pueda:
   *   - abs: la cotizacion real leida del eje (`quote`). No depende de las velas, asi que
   *     sirve aunque un globo o un aviso de la plataforma tape parte de la grafica.
   *   - relativa a las velas de referencia (cuando el eje no esta a la vista).
   */
  const markNow = (priceY, completed, quote) => {
    const reference = pickReference(completed);
    if (priceY === null || (!reference && !quote)) return null;
    return {
      price: reference ? relativePrice(priceY, reference).value : null,
      reference,
      abs: quote ? quote.value : null,
    };
  };

  /** Fila (pixeles de esta lectura) donde queda una marca de precio, o null si no se puede ubicar. */
  const rowOfMark = (mark, priceY, completed, quote) => {
    if (!mark) return null;
    if (mark.abs !== null && quote && priceY !== null) return priceY - (mark.abs - quote.value) / quote.perPixel;
    if (!mark.reference) return null;
    const segment = findReference(mark.reference, completed);
    if (!segment) return null;
    const high = Math.max(...segment.map((c) => c.high));
    const low = Math.min(...segment.map((c) => c.low));
    return -(low + mark.price * (high - low || 1));
  };

  /** Marca de un precio dado por su fila (no el del instante): para la linea de entrada sugerida. */
  const markAtRow = (row, priceY, completed, quote) =>
    markNow(row, completed, quote && priceY !== null ? { value: quote.value + (priceY - row) * quote.perPixel, perPixel: quote.perPixel } : null);

  /** Movimiento del precio desde una marca: 'up' | 'down' | 'flat', o null si no se puede medir. */
  const moveSince = (mark, priceY, completed, quote) => {
    if (!mark || priceY === null) return null;
    if (mark.abs !== null && quote) {
      const change = quote.value - mark.abs;
      if (Math.abs(change) < quote.perPixel / 2) return 'flat'; // menos de medio pixel
      return change > 0 ? 'up' : 'down';
    }
    if (!mark.reference) return null;
    const segment = findReference(mark.reference, completed);
    if (!segment) return null;
    const current = relativePrice(priceY, segment);
    const change = current.value - mark.price;
    if (Math.abs(change) < current.pixel / 2) return 'flat'; // menos de medio pixel
    return change > 0 ? 'up' : 'down';
  };

  const remember = (move) => {
    if (move === null) moves = []; // no se sabe que hizo el precio: se olvida la racha
    else moves = [...moves, move].slice(-4);
  };

  /**
   * Guarda la lectura del precio, relativa a las velas de referencia de ese momento.
   * Asi sigue sirviendo aunque la grafica cambie de escala o se desplace (que es justo
   * lo que pasa cuando el precio empuja a un nuevo maximo o minimo).
   */
  const recordTick = (priceY, completed, now, quote) => {
    ticks = ticks.filter((t) => now - t.time <= TICK_MEMORY_MS);
    const reference = pickReference(completed);
    if (priceY === null || (!reference && !quote)) return;
    ticks.push({
      time: now,
      value: reference ? relativePrice(priceY, reference).value : null,
      reference,
      abs: quote ? quote.value : null,
    });
  };

  /** Las lecturas guardadas, pasadas a filas de la escala actual. Las que ya no se reconocen se omiten. */
  const ticksInView = (completed, quote) => {
    const out = [];
    // Con la cotizacion real a la vista se usa esa (pasada a pixeles de la escala actual).
    if (quote) {
      for (const t of ticks) if (t.abs !== null) out.push({ time: t.time, y: -t.abs / quote.perPixel });
      return out;
    }
    for (const t of ticks) {
      if (!t.reference) continue;
      const segment = findReference(t.reference, completed);
      if (!segment) continue;
      const high = Math.max(...segment.map((c) => c.high));
      const low = Math.min(...segment.map((c) => c.low));
      out.push({ time: t.time, y: -(low + t.value * (high - low || 1)) });
    }
    return out;
  };

  return {
    /**
     * @param {object} input
     * @param {Array} input.candles      Velas leidas (la ultima en curso).
     * @param {number|null} input.priceY Fila de la linea de precio (pixeles; menor = mas arriba).
     * @param {number} input.now         Reloj en milisegundos.
     * @param {number} input.cycleMs     Cuanto dura cada senal antes de calificarse.
     * @param {number} [input.pauseMs]   Cuanto se analiza antes de cada senal.
     * @param {number} input.payout      Pago de la plataforma (%).
     * @param {{dir:string|null, reason:string, confidence?:string}} [input.advice]  Opinion
     *        externa (IA) para la proxima senal. Si viene, sustituye a la votacion de las reglas.
     * @param {boolean} [input.force]    Dar siempre ARRIBA o ABAJO (nunca ESPERAR).
     * @param {boolean} [input.manual]   Solo predecir cuando se llame a predict().
     * @param {boolean} [input.waitForAdvice]  Modo manual: hay una consulta a la IA en camino;
     *        el analisis se alarga un poco para esperarla.
     * @param {{vote:number,text:string}} [input.context]  Resumen de las 8 lecturas; cuenta en la votacion.
     * @param {boolean} [input.clean]  false = no hay forma de medir el precio en esta lectura: con ella
     *        no se empieza ni se termina nada.
     * @param {{value:number, perPixel:number}} [input.quote]  Cotizacion real leida del eje y cuanto
     *        vale un pixel. Con ella, senales y lecturas se miden sin depender de las velas.
     * @param {boolean} [input.formingOk]  false = la vela en curso esta tapada: su patron no vota.
     * @param {number} [input.entryMs]  Cuanto tarda el usuario en poner la orden tras ver la senal. La
     *        senal se mide desde ese momento y durante cycleMs (el tramo que de verdad se opera).
     * @param {boolean} [input.align]  Modo manual: PREDECIR se alinea con el cambio de vela y la
     *        senal vale hasta el CIERRE de esa vela (se califica ahi, contra el precio de la senal).
     * @param {{known:boolean, seconds:number, elapsedMs:number|null, remainingMs:number|null,
     *          closedNow:boolean, closeRow:number|null}} [input.candle]  Reloj de la vela en curso
     *        (ver candleclock.js). closedNow = acaba de cerrar una vela; closeRow = fila del cierre
     *        de la ultima vela cerrada, si esta lectura es de fiar (null si no).
     */
    update({
      candles,
      priceY,
      now,
      cycleMs,
      pauseMs = 0,
      payout,
      advice = null,
      force = false,
      manual = false,
      waitForAdvice = false,
      context = null,
      regime = null,
      memory = null,
      clean = true,
      quote = null,
      formingOk = true,
      entryMs = 0,
      align = false,
      waitNext = true, // con `align`: esperar a que abra la vela siguiente si la actual ya va avanzada
      suggest = false, // zona de entrada sugerida: dos lineas entre las que esta bien entrar (ver entry.js)
      candle = null,
    }) {
      const completed = candles.slice(0, -1);
      const aligned = Boolean(align) && manual; // solo con el boton PREDECIR
      const clockKnown = Boolean(candle && candle.known);
      let status = 'ok';
      if (candles.length < 3) status = 'no-chart';
      else if (priceY === null) status = 'no-price';
      else if (!clean) status = 'covered'; // algo tapa la grafica: esta lectura no se usa
      if (clean) recordTick(priceY, completed, now, quote);
      const recentTicks = ticksInView(completed, quote);
      const previousGood = lastGood;
      if (status === 'ok') lastGood = { time: now, priceY, completed, quote };

      // 0) Momento de entrada: la orden del usuario no entra en el instante en que aparece la
      //    senal, sino un poco despues (lo que tarda en hacer clic). La senal se mide desde ahi,
      //    que es el tramo que de verdad se opera.
      if (pending && !pending.entered && now - pending.time >= pending.entryMs) {
        if (clean) {
          const entry = markNow(priceY, completed, quote);
          if (entry) pending.mark = entry;
          pending.entered = true;
        } else if (now - pending.time >= pending.entryMs + 1000) pending.entered = true; // no se pudo leer: vale la marca de la senal
      }

      // 0b) Entrada sugerida: la senal marca una linea un poco en contra (mas arriba en una venta,
      //     mas abajo en una compra). En cuanto el precio llega a la linea la entrada se da por
      //     tomada, y desde ahi se mide: la referencia pasa a ser el precio de la linea.
      if (pending && pending.entry && !pending.entry.filled && clean && priceY !== null && !pending.dueAt) {
        const ended = pending.untilClose ? Boolean(candle && candle.closedNow && now > pending.time) : now - pending.time >= cycleMs + pending.entryMs;
        const entryRow = ended ? null : rowOfMark(pending.entry.mark, priceY, completed, quote);
        if (entryRow !== null && (pending.dir === 'down' ? priceY <= entryRow + 0.5 : priceY >= entryRow - 0.5)) {
          pending.entry.filled = true;
          pending.entry.filledAt = now;
          pending.mark = pending.entry.mark;
        }
      }

      // 1) Termino la senal: se califica. Si justo ahora la grafica esta tapada, se usa la
      //    ultima lectura buena (si es de ese momento) o se espera un poco a que se destape.
      let sample = null;
      let giveUp = false;
      if (pending && pending.untilClose) {
        // La senal vale hasta el CIERRE de la vela: se califica cuando cierra (visto en la grafica,
        // o dado por el reloj si algo la tapaba), comparando ese cierre con el precio de la senal.
        if (!pending.dueAt && candle && candle.closedNow && now > pending.time) pending.dueAt = now;
        if (!pending.dueAt && now - pending.time > pending.maxWaitMs) {
          pending.dueAt = now; // no se llego a ver ni a inferir el cierre: no se inventa un resultado
          pending.lost = true;
        }
        if (pending.dueAt) {
          const closeRow = candle && Number.isFinite(candle.closeRow) ? candle.closeRow : null;
          if (pending.lost) giveUp = true;
          else if (clean && closeRow !== null) {
            // El cierre exacto de la vela que acaba de cerrar (no el precio de un instante despues).
            sample = {
              priceY: closeRow,
              completed,
              quote: quote && priceY !== null ? { value: quote.value + (priceY - closeRow) * quote.perPixel, perPixel: quote.perPixel } : null,
            };
          } else if (now - pending.dueAt > pending.graceMs) giveUp = true; // la grafica siguio tapada
        }
      } else if (pending && now - pending.time >= pending.spanMs + pending.entryMs) {
        const due = pending.time + pending.spanMs + pending.entryMs;
        if (clean) {
          if (pending.waited && now - due > SCORE_LATE_MS) giveUp = true;
          else sample = { priceY, completed, quote };
        } else if (previousGood && previousGood.time >= due - SCORE_EARLY_MS) sample = previousGood;
        else if (now - due > SCORE_MAX_WAIT_MS) giveUp = true;
        else pending.waited = true;
      }
      if (sample || giveUp) {
        const move = sample ? moveSince(pending.mark, sample.priceY, sample.completed, sample.quote) : null;
        remember(move);
        // Sin lado no hubo prediccion: se dice asi (antes se quedaba el resultado de la senal anterior).
        if (!pending.dir) lastResult = 'no dio predicción (sin lectura clara)';
        if (pending.dir) {
          // Con entrada sugerida: si el precio nunca llego a la linea, no hubo operacion que medir.
          if (pending.entry && !pending.entry.filled) lastResult = 'sin entrada: el precio no llegó a la línea sugerida';
          else if (giveUp) lastResult = 'no se pudo medir (la gráfica estaba tapada)';
          else if (move === null) lastResult = 'no se pudo medir (cambió la gráfica)';
          else if (move === 'flat') {
            live.ties++;
            lastResult = 'empate';
          } else if (move === pending.dir) {
            live.wins++;
            lastResult = 'acertó';
          } else {
            live.losses++;
            lastResult = 'falló';
          }
        }
        pending = null;
        observed = false; // toca analizar antes de la siguiente
        armed = false; // en modo manual hay que volver a pulsar
      }

      // 2) Termina el analisis: se anota hacia donde se movio el precio mientras tanto.
      if (watching && clean) {
        const elapsed = now - watching.time;
        // En modo manual la senal sale en cuanto contesta la IA, o se la espera un poco mas.
        const answered = manual && Boolean(advice);
        const waiting = manual && waitForAdvice && elapsed < pauseMs + MAX_HOLD_MS;
        if (answered || (elapsed >= pauseMs && !waiting)) {
          remember(moveSince(watching.mark, priceY, completed, quote));
          watching = null;
          observed = true;
        }
      }

      // 2b) PREDECIR alineado con la vela: se predice la vela en curso solo si acaba de abrir; si ya
      //     va avanzada, se espera a que abra la siguiente y el analisis empieza justo ahi.
      //     (Con waitNext = false no se espera nunca: PREDECIR analiza y predice al momento.)
      let hold = false;
      if (aligned && waitNext && armed && !pending && !watching && !observed) {
        if (!waiting) waiting = { since: now, lastPriceAt: now, closeAt: clockKnown ? now - candle.elapsedMs : null };
        if (candle && candle.closedNow) waiting.closeAt = now; // acaba de abrir una vela nueva
        if (status === 'ok') waiting.lastPriceAt = now;
        const limit = clockKnown ? Math.min(EARLY_CANDLE_MS, (candle.seconds * 1000) / 3) : UNKNOWN_CANDLE_START_MS;
        const fresh = waiting.closeAt !== null && now - waiting.closeAt <= limit;
        if (fresh && status === 'ok') {
          waiting = null; // la vela acaba de abrir: se analiza y se predice ESTA
        } else if (now - waiting.lastPriceAt >= PRICE_LOST_MS) {
          // El precio dejo de llegar: se cancela y el panel vuelve a LISTO.
          waiting = null;
          armed = false;
          lastResult = `se canceló: el precio dejó de llegar durante ${Math.round(PRICE_LOST_MS / 1000)} s`;
        } else {
          if (!fresh) waiting.closeAt = null; // esa vela ya va avanzada: toca esperar a la siguiente
          hold = true;
        }
      } else if (waiting) waiting = null;

      // 3) Sin senal ni analisis en curso: empieza lo que toque (en manual, solo si se pidio).
      if (!hold && !pending && !watching && status === 'ok' && (!manual || armed)) {
        const mark = markNow(priceY, completed, quote);
        if (mark && pauseMs > 0 && !observed) {
          watching = { mark, time: now };
        } else if (mark) {
          const trend = trendSignal(candles); // incluye la vela en curso
          const current = candles[candles.length - 1];
          // Si algo tapa la vela en curso, su forma no se puede leer: no vota (el precio si se sigue).
          const pattern = formingOk
            ? candlePattern(current, candles[candles.length - 2], completed)
            : { vote: 0, text: 'tapada por un aviso de la plataforma', short: 'tapada' };
          const fallback = current.dir === 'up' || current.dir === 'down' ? current.dir : null;
          const rules = decide(trend, pattern, moves, { force, fallback, ticks: tickMomentum(recentTicks, now), context, regime, memory, formation: findFormation(completed) });
          // Si la IA ya opino sobre este tramo, manda ella; si no, las reglas. Si hay que dar
          // siempre un lado y la IA no eligio ninguno, se usa el de las reglas.
          let useAi = Boolean(advice) && (advice.dir !== null || !force);
          let dir = useAi ? advice.dir : rules.dir;
          let reason = useAi ? advice.reason : rules.reason;
          let confidence = useAi ? advice.confidence || (dir ? 'media' : 'ninguna') : rules.confidence;
          // La IA contesto con datos de hace unos segundos. Si en este instante el precio va
          // claramente en contra de lo que dijo, se avisa y la señal queda como confianza baja.
          const liveNow = tickMomentum(recentTicks, now);
          if (useAi && dir && liveNow.vote === (dir === 'up' ? -2 : 2)) {
            confidence = 'baja';
            reason = `Ojo: ahora mismo el precio va en contra (${liveNow.text}). ${reason}`;
          }
          // FRENO PARA LA IA (13 nov 2026): los mismos frenos que ya tenian las reglas del panel.
          // La IA tiende a seguir lo que viene pasando. Si la vela en curso YA esta estirada hacia
          // el lado de la senal (cuerpo de 1.5 veces lo normal o mas), o ya van 4 o mas velas
          // cerradas seguidas de ese color, seguirla es entrar al final del movimiento (la senal
          // de las 19:10 del 13 nov: tres IA dijeron ABAJO en el piso de una caida y reboto).
          //   - Sin "dar siempre un lado": la senal queda en ESPERAR.
          //   - Con "dar siempre un lado": se conserva el lado de la IA, como confianza baja.
          // No aplica si esta medido que en esta grafica el precio viene CONTINUANDO.
          let braked = false;
          if (useAi && dir && !(regime && regime.kind === 'continua')) {
            let streak = 0;
            for (let i = completed.length - 1; i >= 0 && completed[i].dir === dir; i--) streak++;
            let why = '';
            if (pattern.blocks === dir) why = `la vela en curso está ${pattern.text}`;
            else if (streak >= AI_STREAK_BRAKE) why = `ya van ${streak} velas ${dir === 'up' ? 'verdes' : 'rojas'} seguidas`;
            if (why) {
              braked = true;
              if (force) {
                confidence = 'baja';
                reason = `Freno: ${why}; seguirla es entrar al final del movimiento. ${reason}`;
              } else {
                reason = `Freno: ${why}. La IA decía ${dir === 'up' ? 'ARRIBA' : 'ABAJO'}, pero no se persigue un movimiento que ya ocurrió.`;
                dir = null;
                confidence = 'ninguna';
              }
            }
          }
          // FRENO: no perseguir un movimiento agotado. Si el precio ya recorrio mucho en pocas
          // velas y esta en el extremo de lo que se ve, una senal en esa misma direccion (de la
          // IA o de las reglas) es apostar a que siga justo donde suele darse la vuelta.
          //   - Si ya hay senal de giro (el precio giro desde el extremo, o la vela en curso
          //     rechaza: mecha larga, envolvente), la senal pasa al lado contrario.
          //   - Si no la hay: sin senal; o, si hay que dar siempre un lado, tambien el contrario
          //     (el rebote), marcado como "confianza baja".
          // No se aplica si esta medido que en esta grafica el precio viene CONTINUANDO, ni a
          // plazos cortos (menos de 30 s): ahi lo que manda es el movimiento del instante.
          const longTrade = cycleMs >= 30000;
          const spent = longTrade && formingOk && !(regime && regime.kind === 'continua') ? climax(candles) : null;
          if (spent && dir === spent.dir) {
            const back = spent.dir === 'down' ? 'up' : 'down';
            const sign = back === 'up' ? 1 : -1;
            const turned = liveNow.turn === back || pattern.vote * sign > 0;
            if (turned) {
              dir = back;
              useAi = false;
              confidence = 'media';
              reason = `Giro tras un movimiento agotado: ${spent.text}, y ya hay señal de vuelta (${liveNow.turn === back ? liveNow.text : pattern.text}).`;
            } else if (force) {
              dir = back;
              useAi = false;
              confidence = 'baja';
              reason = `Movimiento agotado: ${spent.text}. Ahí suele darse la vuelta, pero todavía no hay señal de giro.`;
            } else {
              dir = null;
              confidence = 'ninguna';
              reason = `No se persigue un movimiento agotado: ${spent.text}. Espero la señal de giro.`;
            }
          }
          // Con el reloj de la vela en hora, la senal vale hasta el cierre de la vela en curso y se
          // mide contra el precio de este instante. Sin reloj (aun no se sabe cuanto dura la vela)
          // no se promete un cierre que no se puede ubicar: esa senal se califica a los cycleMs.
          // Sin lado (ESPERAR) no se espera ni al cierre de la vela ni al plazo entero: 10 segundos.
          const untilClose = aligned && clockKnown && Boolean(dir);
          // Zona de entrada sugerida (ver entry.js): dos lineas, la del mejor precio (la orilla) y la
          // limite. El precio de la senal queda dentro, asi que la entrada de referencia es la de
          // este instante (`mark`): desde ahi se mide la senal.
          let entryPlan = null;
          if (suggest && dir) {
            const ranges = completed.slice(-20).map((c) => c.high - c.low).sort((a, b) => a - b);
            const zone = suggestZone({ dir, priceY, forming: current, unit: ranges[Math.floor((ranges.length - 1) / 2)] || 0 });
            const best = zone ? markAtRow(zone.bestRow, priceY, completed, quote) : null;
            const limit = zone ? markAtRow(zone.limitRow, priceY, completed, quote) : null;
            if (best && limit) entryPlan = { mark, best, limit, kind: 'zona', text: zone.text, filled: true, filledAt: now };
          }
          pending = {
            dir,
            mark,
            time: now,
            entryMs: untilClose ? 0 : Math.max(0, entryMs || 0),
            entered: untilClose || !(entryMs > 0),
            untilClose,
            // Cuanto dura la senal cuando se mide por segundos: el plazo; sin prediccion, 10 s como mucho.
            spanMs: dir ? cycleMs : Math.min(cycleMs, NO_SIGNAL_MS),
            entry: entryPlan, // linea de entrada sugerida: { mark, kind, text, filled }
            // Tope para ver (o inferir) el cierre: lo que le falta a la vela mas una vela entera.
            maxWaitMs: untilClose ? candle.remainingMs + candle.seconds * 1000 : 0,
            // Si al cierre la grafica esta tapada, cuanto se espera a poder leer la vela cerrada
            // (menos de una vela: despues ya no se sabria cual era).
            graceMs: untilClose ? Math.max(SCORE_MAX_WAIT_MS, Math.min(30000, candle.seconds * 800)) : 0,
            info: {
              dir,
              trend: trend.trend,
              rsi: trend.rsi,
              reason,
              confidence,
              readings: rules.readings,
              source: useAi ? 'ia' : 'reglas',
              braked, // el freno para la IA cambio o bajo esta senal
              untilClose,
            },
          };
        }
      }

      // Lecturas en vivo (para verlas en el panel aunque no haya senal en curso).
      let readings = null;
      if (status === 'ok' && candles.length >= 2) {
        const trend = trendSignal(candles);
        const pattern = candlePattern(candles[candles.length - 1], candles[candles.length - 2], completed);
        readings = { ...decide(trend, pattern, moves, { ticks: tickMomentum(recentTicks, now) }).readings, rsi: trend.rsi };
      }

      let phase = 'idle';
      let remainingMs = 0;
      if (pending) {
        phase = 'signal';
        if (pending.untilClose) remainingMs = pending.dueAt || !clockKnown ? 0 : candle.remainingMs; // hasta el cierre de la vela
        else remainingMs = Math.max(0, pending.spanMs + pending.entryMs - (now - pending.time));
      } else if (watching) {
        phase = 'analysis';
        remainingMs = Math.max(0, pauseMs - (now - watching.time));
      } else if (waiting) {
        phase = 'waiting'; // esperando a que abra la vela siguiente
        remainingMs = clockKnown ? candle.remainingMs : 0;
      }

      return {
        status,
        phase,
        signal: pending ? pending.info : null,
        candles: candles.length,
        lastResult,
        remainingMs,
        untilClose: Boolean(pending && pending.untilClose), // la senal en curso se califica al cierre de la vela
        // Entrada sugerida de la senal en curso: fila de la linea (null si no se puede ubicar ahora),
        // si es en la orilla o a media zona, y si el precio ya llego (entrada tomada).
        entry:
          pending && pending.entry
            ? (() => {
                const best = pending.entry.best ? rowOfMark(pending.entry.best, priceY, completed, quote) : null;
                const limit = pending.entry.limit ? rowOfMark(pending.entry.limit, priceY, completed, quote) : null;
                const zone = best !== null && limit !== null ? { best, limit } : null;
                return {
                  row: rowOfMark(pending.entry.mark, priceY, completed, quote), // linea de referencia: donde se entro
                  kind: pending.entry.kind,
                  text: pending.entry.text,
                  filled: pending.entry.filled,
                  zone, // filas de las dos lineas: mejor precio (orilla) y limite
                  // El precio de este instante sigue entre las dos lineas.
                  inZone: zone && priceY !== null ? priceY >= Math.min(best, limit) - 0.5 && priceY <= Math.max(best, limit) + 0.5 : null,
                };
              })()
            : null,
        clockKnown, // se sabe cuanto le falta a la vela (para la cuenta regresiva)
        ready: status === 'ok' && !pending && !watching && !armed, // se puede pulsar PREDECIR
        moves, // movimientos por tramos y lecturas finas (para quien opine sobre la proxima senal)
        ticks: recentTicks,
        readings,
        formation: status === 'ok' ? findFormation(completed) : null, // figura de varias velas, si hay
        live: summarize(live, payout),
        visible: null, // el repaso por velas no aplica a este modo
      };
    },

    /** Modo manual: pide una prediccion. Devuelve false si ya hay una en curso. */
    predict() {
      if (pending || watching || armed) return false;
      armed = true;
      observed = false;
      return true;
    },

    reset() {
      live.wins = 0;
      live.losses = 0;
      live.ties = 0;
      lastResult = '';
      moves = [];
      ticks = [];
      lastGood = null;
      pending = null;
      watching = null;
      observed = false;
      armed = false;
      waiting = null;
    },
  };
}

module.exports = { createTimedTracker, relativePrice, pickReference, findReference, decide, tickMomentum, EARLY_CANDLE_MS, PRICE_LOST_MS, NO_SIGNAL_MS, AI_STREAK_BRAKE };
