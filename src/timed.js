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
const { findFormation, patternOf } = require('./formations');
const { antiRebound } = require('./rebound');
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
// SEGUIMIENTO (martingala, 15 nov 2026): la senal no se suelta al salir. Mientras dura se sigue
// escaneando y se dice como va (ganando / perdiendo). Si va perdiendo en su tramo final se avisa
// hacia donde saldria la martingala; y si termina perdiendo, la martingala sale en ese mismo
// instante, sin pausa ni consulta a la IA: hacia donde va el precio AHORA (lo que se esta
// escaneando) y, si no se ve claro, hacia donde se fue en la operacion perdida.
// El aviso previo aparece en el ultimo cuarto de la senal (o en sus ultimos 1.5 s, lo que sea mas).
// DOS ETAPAS (15 nov 2026): 1) ESPERA DE ENTRADA: sale la senal y se espera a que el usuario ponga
// su operacion (se ve su marca en la grafica, ver ordermark.js); 2) OPERACION: el plazo de la senal
// se cuenta desde ESE momento y se mide contra el precio de la entrada. Si no entra en el tiempo
// de espera, no hay operacion que seguir. La martingala pasa por las mismas dos etapas.
// La marca se ve un instante despues de la entrada real (lo que tarda la plataforma en dibujarla
// mas las dos lecturas seguidas que se piden para darla por buena): el plazo se cuenta desde
// este tiempo antes de haberla confirmado.
const ENTRY_SEEN_LAG_MS = 400;
// Con el bot (ver botbridge.js) el resultado lo da la plataforma: al terminar el plazo se le espera
// este tiempo antes de calificar con el precio propio.
const EXTERNAL_WAIT_MS = 2500;
// PREDICCION AL ABRIR CADA VELA NUEVA (15 nov 2026): el analisis se hace al final de la vela en
// curso (empieza cuando le falta lo que dura el analisis, mas este margen) y la senal sale en
// cuanto abre la vela siguiente (dentro de sus primeros SYNC_OPEN_MS). Hace falta el reloj de la
// vela; sin el, todo sigue como antes. La martingala analizada tambien sale al abrir vela (abajo).
const SYNC_LEAD_MS = 500;
// Si a la vela le falta menos que el analisis menos esto, ya no da tiempo: se espera a la vela siguiente
// (15 nov, en vivo: un analisis que arranco tarde saco la senal a los 3.5 s de la vela).
const SYNC_LATE_MS = 1500;
const SYNC_OPEN_MS = 2500;
const SYNC_MAX_WAIT_MS = 20000; // tope de espera con el analisis ya hecho (por si el reloj falla)
// MARTINGALA AL ABRIR VELA (15 nov 2026, tarde): la martingala analizada ya no sale a media vela
// (salia en el segundo 6). Sale al abrir la vela siguiente a la de la perdida; si a esa vela le
// falta menos que esto, a la que le sigue (no daria tiempo de analizar nada).
const MARTIN_SYNC_MIN_MS = 1500;
// SIN RELOJ NO SE PREDICE (15 nov 2026, noche): con `waitClock`, si no se sabe en que segundo va la
// vela no sale ni senal ni martingala (antes salian «como antes», a media vela). La martingala
// espera este tiempo a que vuelva el reloj; si no vuelve, se suelta.
const CLOCK_WAIT_MS = 30000;
const MARTIN_ALERT_MS = 1500;
const MARTIN_ALERT_PART = 0.25;
const OPPOSITE = { up: 'down', down: 'up' };

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
  // Senales vetadas que se siguen midiendo en papel: { kind, dir, pattern, mark, time, dueAt }
  let shadows = [];
  // Seguimiento: la senal anterior perdio y toca martingala: { level, lostDir }
  let nextMartin = null;
  let observedAt = 0; // cuando termino el ultimo analisis

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
      // Tolerancia del empate: medio pixel cuando el precio se lee de la pantalla; con la fuente
      // interna (precio exacto) la da quien llama (`quote.tolerance`).
      const tolerance = Number.isFinite(quote.tolerance) ? quote.tolerance : quote.perPixel / 2;
      if (Math.abs(change) < tolerance) return 'flat';
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
     * @param {boolean} [input.antiRebote]  Veto anti-rebote: no dar senal a favor de una vertical
     *        recien hecha (ver rebound.js). La senal vetada queda en ESPERAR y se mide en papel.
     * @param {Object<string,string>} [input.vetoedPatterns]  Patrones desactivados por estadistica:
     *        { clave: motivo }. Una senal de esos patrones queda en ESPERAR y se mide en papel.
     * @param {number} [input.martin]  Seguimiento: cuantas martingalas seguidas se dan como mucho
     *        cuando una senal pierde (0 = ninguna).
     * @param {number} [input.martinThinkMs]  La martingala se analiza como una prediccion nueva (IA y
     *        reglas); a las IA se les espera este tiempo como mucho. -1 = sin analisis: al instante,
     *        hacia donde va el precio.
     * @param {boolean} [input.newCandle]  La prediccion sale siempre al abrir una vela nueva: se
     *        analiza al final de la vela en curso y la senal aparece al abrir la siguiente.
     * @param {number} [input.entryWaitMs]  Dos etapas: cuanto se espera a que el usuario ponga su
     *        operacion; el plazo de la senal cuenta desde que entra (0 = cuenta desde la senal).
     * @param {boolean|{price?:number, agoMs?:number}} [input.userEntered]  En esta lectura se vio
     *        aparecer la marca de una operacion nueva del usuario en la grafica (true), o el bot
     *        abrio la operacion: entonces viene su precio de entrada y hace cuanto entro.
     * @param {boolean} [input.externalAwait]  La operacion la abrio el bot: su resultado lo dara la
     *        plataforma (se le espera un poco antes de calificar con el precio propio).
     * @param {'win'|'loss'|'tie'|null} [input.externalResult]  Resultado que dio la plataforma de
     *        la operacion en curso: manda sobre la medicion propia.
     * @param {{changed:boolean, was:string, now:string, closed:boolean}|null} [input.lastCandle]
     *        Confirmacion con la vela cerrada (ver lastcandle.js): como quedo la vela que se le enseno
     *        a la IA. Si cambio de color, lo que dijo la IA ya no vale: la senal queda en ESPERAR y
     *        se mide en papel; la martingala la deciden las reglas.
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
      antiRebote = false,
      vetoedPatterns = null,
      martin = 0,
      martinThinkMs = -1,
      newCandle = false,
      entryWaitMs = 0,
      userEntered = false,
      externalAwait = false,
      externalResult = null,
      lastCandle = null,
      waitClock = false, // sin reloj de la vela no se predice (ver CLOCK_WAIT_MS)
      // Con el bot: la senal (y la martingala) sale este tiempo ANTES de que abra la vela, para que la
      // orden llegue a Pocket justo al abrir (el bot espera al segundo entero). 0 = al abrir.
      openLeadMs = 0,
      // DOS SEGUNDOS ANTES (15 nov 2026, noche): el analisis arranca cuando a la vela le falta
      // `syncBeforeMs`, sigue `syncAfterMs` dentro de la vela nueva (para ver como arranca) y ahi
      // sale la senal. 0 = como antes (analisis de `pauseMs` que termina al abrir la vela).
      syncBeforeMs = 0,
      syncAfterMs = 0,
      // AL INICIAR LA VELA (15 nov 2026, 21:00): el analisis (y la consulta a la IA) arranca cuando
      // ABRE cada vela -dentro de sus primeros `openStartMs`-, no antes. La senal sale en cuanto la
      // IA contesta: como pronto a `thinkMinMs` (para ver arrancar la vela) y como tarde a
      // `thinkMaxMs` (ahi deciden las reglas). La martingala igual, al abrir la vela siguiente.
      openStartMs = 0,
      thinkMinMs = 1000,
      thinkMaxMs = 5000,
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

      // 0a) ESPERA DE ENTRADA: la senal ya salio, pero su plazo no cuenta hasta que el usuario pone
      //     la operacion. En cuanto se ve su marca, la senal se mide desde ahi (precio y reloj).
      if (pending && pending.stage === 'entry') {
        const entry = userEntered && clean ? markNow(priceY, completed, quote) : null;
        if (entry) {
          // Entrada del bot: se conoce su precio exacto y hace cuanto fue (no hay que estimarlos).
          const exact = typeof userEntered === 'object' ? userEntered : null;
          if (exact && Number.isFinite(exact.price) && entry.abs !== null) entry.abs = exact.price;
          pending.stage = 'trade';
          pending.mark = entry;
          pending.time = now - (exact && Number.isFinite(exact.agoMs) ? exact.agoMs : ENTRY_SEEN_LAG_MS);
          pending.enteredAt = now;
          pending.entryMs = 0; // ya entro: no hay retraso de entrada que sumar ni otra marca que tomar
          pending.entered = true;
          if (pending.entry) {
            pending.entry.mark = entry; // la linea de referencia pasa al precio de la entrada real
            pending.entry.filled = true;
            pending.entry.filledAt = now;
          }
        } else if (now >= pending.waitUntil) {
          // No entro: no hubo operacion. No se califica nada ni hay martingala.
          lastResult = `sin entrada: no vi tu operación en ${Math.round((pending.waitUntil - pending.time) / 1000)} s`;
          pending = null;
          nextMartin = null;
          observed = false;
          armed = false;
        }
      }

      // 0) Momento de entrada: la orden del usuario no entra en el instante en que aparece la
      //    senal, sino un poco despues (lo que tarda en hacer clic). La senal se mide desde ahi,
      //    que es el tramo que de verdad se opera.
      if (pending && pending.stage !== 'entry' && !pending.entered && now - pending.time >= pending.entryMs) {
        if (clean) {
          const entry = markNow(priceY, completed, quote);
          if (entry) pending.mark = entry;
          pending.entered = true;
        } else if (now - pending.time >= pending.entryMs + 1000) pending.entered = true; // no se pudo leer: vale la marca de la senal
      }

      // 0b) Entrada sugerida: la senal marca una linea un poco en contra (mas arriba en una venta,
      //     mas abajo en una compra). En cuanto el precio llega a la linea la entrada se da por
      //     tomada, y desde ahi se mide: la referencia pasa a ser el precio de la linea.
      if (pending && pending.stage !== 'entry' && pending.entry && !pending.entry.filled && clean && priceY !== null && !pending.dueAt) {
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
      let verdict = null; // resultado dado por la plataforma: 'win' | 'loss' | 'tie'
      if (pending && pending.stage === 'entry') {
        // Esperando la entrada del usuario: todavia no hay nada que calificar.
      } else if (pending && pending.untilClose) {
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
      } else if (pending && pending.dir && externalResult) {
        // La plataforma ya dio el resultado de esta operacion (la abrio el bot): es el que vale.
        verdict = externalResult;
      } else if (pending && now - pending.time >= pending.spanMs + pending.entryMs) {
        const due = pending.time + pending.spanMs + pending.entryMs;
        if (externalAwait && pending.dir && now - due < EXTERNAL_WAIT_MS) {
          // Termino el plazo: se espera un momento el resultado de la plataforma.
        } else if (clean) {
          if (pending.waited && now - due > SCORE_LATE_MS) giveUp = true;
          else sample = { priceY, completed, quote };
        } else if (previousGood && previousGood.time >= due - SCORE_EARLY_MS) sample = previousGood;
        else if (now - due > SCORE_MAX_WAIT_MS) giveUp = true;
        else pending.waited = true;
      }
      if (sample || giveUp || verdict) {
        let move = sample ? moveSince(pending.mark, sample.priceY, sample.completed, sample.quote) : null;
        if (verdict) move = verdict === 'tie' ? 'flat' : verdict === 'win' ? pending.dir : OPPOSITE[pending.dir];
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
        // Seguimiento: la senal perdio y quedan martingalas por dar: sale otra entrada enseguida (paso 2c).
        nextMartin = null;
        if (martin > 0 && pending.dir && lastResult === 'falló' && (pending.level || 0) < martin) {
          nextMartin = { level: (pending.level || 0) + 1, lostDir: pending.dir, since: now };
        }
        pending = null;
        observed = false; // toca analizar antes de la siguiente
        armed = false; // en modo manual hay que volver a pulsar
      }

      // 1b) Senales VETADAS (anti-rebote o patron desactivado): no se mostraron, pero se miden en
      //     papel al mismo plazo, para saber que habria pasado y para que un patron pueda reactivarse.
      const vetoResults = [];
      if (shadows.length) {
        shadows = shadows.filter((s) => {
          if (now < s.dueAt) return true;
          let result = null;
          if (clean) {
            const move = moveSince(s.mark, priceY, completed, quote);
            result = move === null ? 'sin medir' : move === 'flat' ? 'empate' : move === s.dir ? 'acertó' : 'falló';
          } else if (now - s.dueAt > SCORE_MAX_WAIT_MS) result = 'sin medir';
          if (result === null) return true;
          vetoResults.push({ kind: s.kind, dir: s.dir, pattern: s.pattern, time: s.time, result });
          return false;
        });
      }

      // 2) Termina el analisis: se anota hacia donde se movio el precio mientras tanto.
      if (watching && clean) {
        const elapsed = now - watching.time;
        // En modo manual la senal sale en cuanto contesta la IA, o se la espera un poco mas.
        const answered = manual && Boolean(advice) && !watching.endAt && !watching.openStart;
        const waiting = manual && waitForAdvice && elapsed < pauseMs + MAX_HOLD_MS && !watching.endAt && !watching.openStart;
        // Al iniciar la vela: termina en cuanto contesta la IA (viendo la vela al menos `thinkMinMs`), o al tope.
        // Analisis a caballo entre dos velas: termina a su hora (ya dentro de la vela nueva).
        let done = watching.endAt ? now >= watching.endAt : elapsed >= pauseMs;
        if (watching.openStart) done = (Boolean(advice) && now >= watching.minAt) || now >= watching.maxAt;
        if (answered || (done && !waiting)) {
          remember(moveSince(watching.mark, priceY, completed, quote));
          watching = null;
          observed = true;
          observedAt = now;
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

      /** Zona de entrada sugerida (ver entry.js) para una senal hacia `dir` marcada en `mark`. */
      const zonePlan = (dir, mark) => {
        const ranges = completed.slice(-20).map((c) => c.high - c.low).sort((a, b) => a - b);
        const zone = suggestZone({ dir, priceY, forming: candles[candles.length - 1], unit: ranges[Math.floor((ranges.length - 1) / 2)] || 0 });
        const best = zone ? markAtRow(zone.bestRow, priceY, completed, quote) : null;
        const limit = zone ? markAtRow(zone.limitRow, priceY, completed, quote) : null;
        return best && limit ? { mark, best, limit, kind: 'zona', text: zone.text, filled: true, filledAt: now } : null;
      };

      // 2c) SEGUIMIENTO (martingala): la senal anterior acaba de perder y toca otra entrada.
      //   - Con `martinThinkMs` (15 nov 2026, «aplica el martingala sin entender»): la martingala se
      //     ANALIZA como una prediccion nueva. Se consulta a las IA y se les espera ese tiempo como
      //     mucho; el lado es el de las IA y, si no contestan o no eligen, el de las reglas del
      //     panel con todas sus lecturas (tendencia, vela actual, tramos, niveles, patron medido).
      //   - Sin el: como al principio, en el mismo instante y hacia donde va el precio.
      //   - AL ABRIR VELA (15 nov, tarde): con `newCandle` y el reloj de la vela, la martingala
      //     analizada tampoco sale a media vela: espera a que abra la vela siguiente (la hora se fija
      //     al perder y el reloj la va afinando). Mientras tanto se sigue escaneando.
      let thinking = false; // martingala: esperando el nuevo analisis (o a que abra la vela)
      let thinkLeftMs = 0; // cuanto falta para que salga
      if (nextMartin && !pending) {
        const smart = Number.isFinite(martinThinkMs) && martinThinkMs >= 0;
        let clockWait = false; // sin reloj: se espera a que vuelva antes de fijar la hora de salida
        if (smart && newCandle && nextMartin.openAt === undefined) {
          if (clockKnown && Number.isFinite(candle.remainingMs)) {
            // (Con `syncAfterMs` la martingala tambien sale ese tiempo despues de abrir la vela.)
            // (Al iniciar la vela: la martingala se analiza al abrir la vela siguiente, sea cual sea lo que falte.)
            const skip = openStartMs > 0 ? 0 : candle.remainingMs < MARTIN_SYNC_MIN_MS ? candle.seconds * 1000 : 0;
            nextMartin.openAt = now + candle.remainingMs + syncAfterMs + skip;
          } else if (waitClock) clockWait = true;
          else nextMartin.openAt = null;
        }
        if (clockWait && now - nextMartin.since >= CLOCK_WAIT_MS) {
          lastResult = 'martingala suelta: no hubo reloj de la vela para darla a tiempo';
          nextMartin = null;
        }
      }
      if (nextMartin && !pending && nextMartin.openAt === undefined && waitClock && Number.isFinite(martinThinkMs) && martinThinkMs >= 0 && newCandle) {
        thinking = true; // esperando el reloj de la vela
      } else if (nextMartin && !pending) {
        const smart = Number.isFinite(martinThinkMs) && martinThinkMs >= 0;
        const synced = smart && Number.isFinite(nextMartin.openAt);
        if (synced && clockKnown && Number.isFinite(candle.remainingMs)) {
          const estimate = now + candle.remainingMs + syncAfterMs; // cuando toca salir, segun el reloj de ahora
          if (Math.abs(estimate - nextMartin.openAt) < 1000) nextMartin.openAt = estimate;
        }
        const waited = now - nextMartin.since;
        const mark = status === 'ok' ? markNow(priceY, completed, quote) : null;
        if (synced && openStartMs > 0) {
          // Al iniciar la vela: se espera a que abra, ahi se consulta a la IA y la martingala sale en
          // cuanto contesta (viendo la vela nueva al menos `thinkMinMs`); al tope deciden las reglas.
          const deadline = nextMartin.openAt + thinkMaxMs;
          if (now < nextMartin.openAt) thinking = true;
          else if (!mark) {
            if (now < deadline + 1500) thinking = true;
            else nextMartin = null;
          } else if (!(advice && now >= nextMartin.openAt + thinkMinMs) && now < deadline) thinking = true;
          if (thinking) thinkLeftMs = Math.max(0, deadline - now);
        } else if (synced) {
          if (now < nextMartin.openAt - openLeadMs) thinking = true;
          else if (!mark) {
            // Abrio la vela pero no se puede leer en este instante: se reintenta un momento.
            if (now < nextMartin.openAt + 1500) thinking = true;
            else nextMartin = null;
          }
          if (thinking) thinkLeftMs = Math.max(0, nextMartin.openAt - now);
        } else if (!mark) {
          // No se puede leer en este instante: con analisis se reintenta un momento; sin el, no hay martingala.
          if (smart && waited < martinThinkMs + 1500) thinking = true;
          else nextMartin = null;
        } else if (smart && !advice && waited < martinThinkMs) {
          thinking = true;
        }
        if (thinking && !synced) thinkLeftMs = Math.max(0, martinThinkMs - waited);
      }
      if (nextMartin && !pending && !thinking) {
        const follow = nextMartin;
        nextMartin = null;
        const mark = markNow(priceY, completed, quote);
        if (mark) {
          const smart = Number.isFinite(martinThinkMs) && martinThinkMs >= 0;
          const liveNow = tickMomentum(recentTicks, now);
          const trend = trendSignal(candles);
          let dir = liveNow.vote > 0 ? 'up' : liveNow.vote < 0 ? 'down' : OPPOSITE[follow.lostDir];
          let why = `y ${liveNow.vote !== 0 ? `ahora el precio va ${liveNow.text}` : `el precio se fue hacia ${dir === 'up' ? 'arriba' : 'abajo'}`}.`;
          let martinConfidence = 'baja';
          if (smart) {
            const live = candles[candles.length - 1];
            const shape = formingOk ? candlePattern(live, candles[candles.length - 2], completed) : { vote: 0, text: 'tapada por un aviso de la plataforma', short: 'tapada' };
            const rules = decide(trend, shape, moves, { force: true, fallback: dir, ticks: liveNow, context, regime, memory, formation: findFormation(completed) });
            // Si la ultima vela cambio de color despues de que la IA la miro, su lectura ya no vale.
            // La martingala no se cancela (es siempre): la deciden las reglas con la vela ya cerrada.
            const stale = Boolean(advice && advice.dir && lastCandle && lastCandle.changed);
            const useAi = Boolean(advice && advice.dir) && !stale;
            dir = useAi ? advice.dir : rules.dir || dir;
            martinConfidence = useAi ? advice.confidence || 'media' : rules.confidence || 'baja';
            const note = stale ? ' (la última vela cambió de color después de que la IA la miró: deciden las reglas)' : '';
            why = `. Nuevo análisis${useAi ? ' de la IA' : ''}${note}: ${useAi ? advice.reason : rules.reason}`;
          }
          watching = null;
          observed = false;
          armed = false;
          pending = {
            dir,
            mark,
            time: now,
            entryMs: 0,
            entered: true,
            untilClose: false,
            spanMs: cycleMs,
            entry: suggest ? zonePlan(dir, mark) : null,
            maxWaitMs: 0,
            graceMs: 0,
            level: follow.level, // 1 = primera martingala
            stage: entryWaitMs > 0 ? 'entry' : 'trade',
            waitUntil: now + entryWaitMs,
            info: {
              dir,
              trend: trend.trend,
              rsi: trend.rsi,
              reason: `Martingala ${follow.level}: la señal ${follow.lostDir === 'up' ? 'ARRIBA' : 'ABAJO'} perdió${smart ? '' : ' '}${why}`,
              confidence: martinConfidence,
              readings: null,
              source: 'martingala',
              martin: follow.level,
              braked: false,
              pattern: patternOf({ candles, dir }),
              veto: null,
              untilClose: false,
            },
          };
        }
      }

      // 2d) PREDICCION AL ABRIR CADA VELA NUEVA: se espera el momento. Primero, a que a la vela en
      //     curso le falte lo que dura el analisis; ya analizado, a que abra la vela siguiente.
      let syncHold = false;
      if (newCandle && clockKnown && !hold && !pending && !watching && !nextMartin && status === 'ok' && (!manual || armed)) {
        const justOpened =
          (candle.elapsedMs !== null && candle.elapsedMs <= SYNC_OPEN_MS) ||
          (openLeadMs > 0 && observed && Number.isFinite(candle.remainingMs) && candle.remainingMs <= openLeadMs);
        if (openStartMs > 0) {
          // AL INICIAR LA VELA: el analisis arranca solo con la vela recien abierta; ya analizada, la
          // senal sale al momento (dentro de esa misma vela).
          syncHold = observed ? false : !(candle.elapsedMs !== null && candle.elapsedMs <= openStartMs);
        } else if (!observed) {
          // El analisis solo arranca en su ventana: cuando a la vela le falta justo lo que dura.
          const inWindow = candle.remainingMs <= pauseMs + SYNC_LEAD_MS && candle.remainingMs >= pauseMs - SYNC_LATE_MS;
          if (syncBeforeMs > 0 && pauseMs > 0) syncHold = !(candle.remainingMs <= syncBeforeMs); // arranca cuando faltan 2 s
          else syncHold = pauseMs > 0 ? !inWindow : !justOpened;
        }
        else syncHold = !justOpened && now - observedAt < SYNC_MAX_WAIT_MS;
      }
      // Sin reloj de la vela no se empieza nada: ni analisis ni senal (se espera a tenerlo).
      if (newCandle && waitClock && !clockKnown && !hold && !pending && !watching && !nextMartin && status === 'ok' && (!manual || armed)) syncHold = true;

      // 3) Sin senal ni analisis en curso: empieza lo que toque (en manual, solo si se pidio).
      if (!hold && !syncHold && !pending && !watching && !nextMartin && status === 'ok' && (!manual || armed)) {
        const mark = markNow(priceY, completed, quote);
        if (mark && pauseMs > 0 && !observed) {
          watching = { mark, time: now };
          // Dos segundos antes: el analisis termina `syncAfterMs` despues de que abra la vela nueva.
          if (syncBeforeMs > 0 && newCandle && clockKnown && Number.isFinite(candle.remainingMs)) watching.endAt = now + candle.remainingMs + syncAfterMs;
          if (openStartMs > 0 && newCandle && clockKnown) {
            watching.openStart = true;
            watching.minAt = now + thinkMinMs;
            watching.maxAt = now + thinkMaxMs;
          }
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
          // PATRON de la senal y VETOS (15 nov 2026). El patron es la situacion de la grafica que
          // disparo la senal (formations.js). Dos vetos pueden dejarla en ESPERAR, mande quien
          // mande (reglas o IA, tambien con "dar siempre un lado"):
          //   - anti-rebote: no entrar a favor de una vertical recien hecha (rebound.js);
          //   - patron desactivado por estadistica (lo decide quien llama, con lo medido).
          // La senal vetada no se muestra, pero se mide en papel al mismo plazo (paso 1b).
          const setup = patternOf({ candles, dir });
          let veto = null;
          if (dir && antiRebote) {
            const check = antiRebound({ candles, dir });
            if (check.veto) veto = { kind: 'anti-rebote', dir, pattern: setup.key, text: check.reason, data: check.data };
          }
          if (dir && !veto && vetoedPatterns && vetoedPatterns[setup.key]) {
            veto = {
              kind: 'patron',
              dir,
              pattern: setup.key,
              text: `Patrón desactivado por estadística: ${setup.text} (${vetoedPatterns[setup.key]}). La señal era ${dir === 'up' ? 'ARRIBA' : 'ABAJO'}.`,
              data: null,
            };
          }
          // CONFIRMACION CON LA VELA CERRADA (15 nov 2026, tarde; ver lastcandle.js). A la IA se le
          // pregunta con la ultima vela todavia en curso. Si entre esa consulta y este instante la
          // vela cambio de color, la IA razono sobre una vela que ya no es: la senal no entra (queda
          // en ESPERAR y se mide en papel, para comprobar si este freno ayuda o estorba).
          if (dir && useAi && !veto && lastCandle && lastCandle.changed) {
            const color = (d) => (d === 'up' ? 'verde' : 'roja');
            veto = {
              kind: 'vela',
              dir,
              pattern: setup.key,
              text: `La última vela cambió de color después de que la IA la miró (iba ${color(lastCandle.was)} y ${lastCandle.closed ? 'cerró' : 'va'} ${color(lastCandle.now)}): su lectura ya no vale. La señal era ${dir === 'up' ? 'ARRIBA' : 'ABAJO'}.`,
              data: { was: lastCandle.was, now: lastCandle.now },
            };
          }
          if (veto) {
            shadows.push({ kind: veto.kind, dir, pattern: setup.key, mark, time: now, dueAt: now + cycleMs });
            reason = veto.text;
            dir = null;
            confidence = 'ninguna';
          }
          // Con el reloj de la vela en hora, la senal vale hasta el cierre de la vela en curso y se
          // mide contra el precio de este instante. Sin reloj (aun no se sabe cuanto dura la vela)
          // no se promete un cierre que no se puede ubicar: esa senal se califica a los cycleMs.
          // Sin lado (ESPERAR) no se espera ni al cierre de la vela ni al plazo entero: 10 segundos.
          const untilClose = aligned && clockKnown && Boolean(dir);
          // Zona de entrada sugerida (ver entry.js): dos lineas, la del mejor precio (la orilla) y la
          // limite. El precio de la senal queda dentro, asi que la entrada de referencia es la de
          // este instante (`mark`): desde ahi se mide la senal.
          const entryPlan = suggest && dir ? zonePlan(dir, mark) : null;
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
            // Dos etapas: primero se espera la entrada del usuario; el plazo cuenta desde que entra.
            stage: entryWaitMs > 0 && dir && !untilClose ? 'entry' : 'trade',
            waitUntil: now + entryWaitMs,
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
              pattern: setup, // { key, text, detail }: situacion de la grafica que disparo la senal
              veto, // null, o { kind: 'anti-rebote'|'patron'|'vela', dir, pattern, text, data }: la senal quedo en ESPERAR
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
        if (pending.stage === 'entry') remainingMs = Math.max(0, pending.waitUntil - now); // lo que queda para entrar
        else if (pending.untilClose) remainingMs = pending.dueAt || !clockKnown ? 0 : candle.remainingMs; // hasta el cierre de la vela
        else remainingMs = Math.max(0, pending.spanMs + pending.entryMs - (now - pending.time));
      } else if (thinking) {
        phase = 'analysis'; // la martingala se esta analizando (o espera a que abra la vela)
        remainingMs = thinkLeftMs;
      } else if (watching) {
        phase = 'analysis';
        remainingMs = watching.openStart ? Math.max(0, watching.maxAt - now) : watching.endAt ? Math.max(0, watching.endAt - now) : Math.max(0, pauseMs - (now - watching.time));
      } else if (waiting || syncHold) {
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
        ready: status === 'ok' && !pending && !watching && !armed && !nextMartin, // se puede pulsar PREDECIR
        // La martingala se esta analizando (fase 'analysis'): que nivel viene.
        thinking: thinking && nextMartin ? nextMartin.level : 0,
        moves, // movimientos por tramos y lecturas finas (para quien opine sobre la proxima senal)
        ticks: recentTicks,
        readings,
        formation: status === 'ok' ? findFormation(completed) : null, // figura de varias velas, si hay
        live: summarize(live, payout),
        // Senales vetadas que acaban de medirse en papel: [{ kind, dir, pattern, time, result }]
        vetoResults,
        // Seguimiento de la senal en curso: como va en este instante (state) y, si va perdiendo en
        // su tramo final y quedan martingalas, hacia donde saldria la siguiente (next).
        // Dos etapas: mientras se espera la entrada del usuario, cuanto le queda para entrar.
        entryWait: pending && pending.stage === 'entry' ? { leftMs: Math.max(0, pending.waitUntil - now), totalMs: pending.waitUntil - pending.time } : null,
        // Si la senal en curso ya cuenta desde la entrada del usuario, hace cuanto entro.
        enteredAgoMs: pending && pending.enteredAt ? now - pending.enteredAt : null,
        follow: (() => {
          if (!pending || !pending.dir || pending.stage === 'entry') return null;
          const move = clean ? moveSince(pending.mark, priceY, completed, quote) : null;
          const state = move === null ? null : move === 'flat' ? 'igual' : move === pending.dir ? 'ganando' : 'perdiendo';
          const level = pending.level || 0;
          let next = null;
          const closing = remainingMs <= Math.max(MARTIN_ALERT_MS, pending.spanMs * MARTIN_ALERT_PART);
          if (martin > 0 && state === 'perdiendo' && level < martin && closing) {
            const liveNow = tickMomentum(recentTicks, now);
            next = { level: level + 1, dir: liveNow.vote > 0 ? 'up' : liveNow.vote < 0 ? 'down' : OPPOSITE[pending.dir] };
          }
          return { state, level, max: martin, next };
        })(),
        visible: null, // el repaso por velas no aplica a este modo
      };
    },

    /** Modo manual: pide una prediccion. Devuelve false si ya hay una en curso. */
    predict() {
      if (pending || watching || armed || nextMartin) return false;
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
      shadows = [];
      nextMartin = null;
      observedAt = 0;
    },
  };
}

module.exports = { createTimedTracker, relativePrice, pickReference, findReference, decide, tickMomentum, EARLY_CANDLE_MS, PRICE_LOST_MS, NO_SIGNAL_MS, AI_STREAK_BRAKE, ENTRY_SEEN_LAG_MS, EXTERNAL_WAIT_MS, SYNC_LEAD_MS, SYNC_LATE_MS, SYNC_OPEN_MS, MARTIN_SYNC_MIN_MS, CLOCK_WAIT_MS };
