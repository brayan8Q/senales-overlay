/**
 * SEGUIMIENTO DE LA VELA ACTUAL EN UNA ZONA (16 nov 2026).
 *
 * El usuario: «soluciona lo de la vela actual, el seguimiento, porque a veces regresa a una anterior» y despues
 * «lo amarillo que lo sigue tiene un desfase». Primero se tomaba como vela actual la mas a la derecha de las que
 * el lector de pantalla encuentra por color: una vela recien abierta (una raya), un doji, o una tapada por el globo
 * de resultado de la plataforma no se detecta, y el recuadro saltaba a la anterior.
 *
 * Ahora la vela actual NO se adivina. El bot da las velas exactas del par (precios); aqui se casan con las que se
 * ven en la pantalla (src/pricemap.js: una recta precio → fila, probando si la ultima vista es la que va en curso
 * o la ultima cerrada). Eso dice cual de las velas vistas es la ULTIMA CERRADA, y la vela actual va siempre en la
 * casilla siguiente de la rejilla (un paso a la derecha; paso = separacion entre velas):
 *   - si en esa casilla la pantalla ve una vela, el recuadro se dibuja con lo que se ve (coincide al pixel);
 *   - si no ve nada ahi (recien abierta, o tapada), se dibuja con los precios del bot;
 *   - si en una lectura nada cuadra (algo tapa la grafica), se sostiene el ultimo dibujo unos segundos y despues
 *     se quita: nunca se marca una vela anterior.
 *
 * (La primera version ademas impedia que el recuadro retrocediera dentro de una misma vela. Medido en la pantalla
 * del usuario: la plataforma recorre la grafica con una animacion al abrir cada vela, una lectura a media
 * animacion daba una posicion corrida y esa regla la dejaba fija toda la vela. Ese era el desfase. Se quito.)
 */
const { fitPriceMap } = require('./pricemap');

const HOLD_MS = 4000; // cuanto se sostiene el ultimo dibujo si una lectura no cuadra
const SHORT_FIT = 9; // segundo intento: solo las ultimas velas (un doji viejo que el lector se salto no estorba)
const SNAP_PX = 4; // una vela vista a menos de esto de la casilla es la vela actual

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

const merge = (list) => ({ open: list[0].open, close: list[list.length - 1].close, high: Math.max(...list.map((c) => c.high)), low: Math.min(...list.map((c) => c.low)) });
/**
 * Las velas del bot (15 s) juntadas de `size` en `size`, como las pinta la plataforma con mas tiempo a la vista
 * (velas de 30 s o de 1 min). No se sabe en cual de las de 15 s empieza cada vela grande, asi que se dan todas las
 * formas (`size` de ellas): `lead` = cuantas de 15 s ya cerradas forman parte de la vela grande en curso.
 */
function widerBooks(book, size) {
  const out = [];
  for (let lead = 0; lead < size; lead++) {
    const done = lead ? book.closed.slice(0, -lead) : book.closed;
    const forming = merge([...(lead ? book.closed.slice(-lead) : []), book.forming]);
    const closed = [];
    for (let end = done.length; end - size >= 0; end -= size) closed.unshift(merge(done.slice(end - size, end)));
    if (closed.length >= 6) out.push({ closed, forming, openFor: book.openFor, seconds: 15 * size, lead });
  }
  return out;
}

/** Separacion entre velas (pixeles de la imagen), de las ultimas vistas. */
function pitchOf(candles) {
  const steps = [];
  for (let i = Math.max(1, candles.length - 12); i < candles.length; i++) steps.push(candles[i].x0 - candles[i - 1].x0);
  const positive = steps.filter((s) => s > 0);
  return positive.length >= 2 ? median(positive) : 0;
}

/**
 * @param {{candles:Array, book:{closed:Array, forming:object, openFor:number}|null, prev:object|null, now:number}} input
 *   candles = velas leidas de la pantalla (unidades de pantalla, x0/x1 en pixeles de la imagen);
 *   book = velas del bot en precios ({open, high, low, close}); prev = lo devuelto en `track` la vez anterior.
 * @returns {{marks:Array, current:object|null, track:object|null, exact:boolean, seconds?:number, debug?:object}}
 *   current = { x0, x1, open, close, high, low, up } en unidades de pantalla; exact = ubicada con las velas del bot.
 */
function trackZone({ candles, book, prev = null, now }) {
  const seen = candles || [];
  if (!book || !book.forming || !book.closed || book.closed.length < 6) {
    // Sin velas del bot: lo de antes (la mas a la derecha).
    const last = seen[seen.length - 1] || null;
    return { marks: seen.slice(0, -1), current: last ? { ...last, up: last.dir !== 'down' } : null, track: null, exact: false };
  }
  const pitch = pitchOf(seen);
  const tryFit = (b) => {
    let f = fitPriceMap(seen, b);
    if (!(f && f.valid) && seen.length > SHORT_FIT) f = fitPriceMap(seen.slice(-SHORT_FIT), b);
    return f && f.valid ? f : null;
  };
  let used = book;
  let fit = pitch > 0 ? tryFit(book) : null;
  // Las de 15 s no casan: la grafica puede estar pintando velas de 30 s o de 1 min.
  for (const size of fit || !(pitch > 0) ? [] : [2, 4]) {
    for (const alt of widerBooks(book, size)) {
      const f = tryFit(alt);
      if (f && (!fit || f.rms < fit.rms)) {
        fit = f;
        used = alt;
      }
    }
    if (fit) break;
  }

  let slot = null; // la casilla de la vela actual: { x0, x1 }
  let map = null;
  let seconds = 15;
  let lead = 0;
  let forming = book.forming;
  if (fit) {
    // El ajuste casa una vela VISTA con una cerrada del bot; de ahi se cuentan casillas hasta la vela en curso:
    //   shift 0  → la penultima vista es la ultima cerrada del bot: la actual va 1 casilla despues;
    //   shift +1 → la penultima vista es la ANTERIOR a la ultima cerrada: 2 casillas despues (sirve igual si la
    //              ultima cerrada no se ve por ser un doji, o si la que no se ve es la vela en curso; idea de Argon);
    //   shift −1 → la pantalla va una vela adelante del bot: la antepenultima vista es su ultima cerrada, 2 casillas.
    const anchor = seen[seen.length - (fit.shift === -1 ? 3 : 2)];
    if (anchor) {
      const width = median(seen.slice(-12).map((c) => c.x1 - c.x0));
      // La casilla que sigue a la ultima cerrada (dos mas alla si la pantalla ya va una vela adelante del bot).
      const steps = fit.shift === 0 ? 1 : 2;
      slot = { x0: anchor.x0 + pitch * steps, x1: anchor.x0 + pitch * steps + width };
      map = { A: fit.A, B: fit.B };
      seconds = used.seconds || 15;
      lead = used.lead || 0;
      forming = used.forming;
    }
  }
  if (!slot && prev && prev.slot && prev.map && now - prev.fitAt <= HOLD_MS) {
    // Esta lectura no cuadra: se sostiene la ultima casilla y la ultima recta (con la misma forma de juntar velas).
    slot = prev.slot;
    map = prev.map;
    seconds = prev.seconds || 15;
    lead = prev.lead || 0;
    if (seconds !== 15) {
      const again = widerBooks(book, seconds / 15).find((b) => b.lead === lead);
      if (again) forming = again.forming;
    }
  }
  if (!slot || !map) return { marks: seen.slice(0, -1), current: null, track: null, exact: false, seconds, debug: { shift: null, pitch, held: false } };

  // Lo que la pantalla ve en esa casilla (si ve algo): con eso el recuadro coincide al pixel con la vela.
  const here = seen.filter((c) => Math.abs(c.x0 - slot.x0) <= SNAP_PX || (c.x0 >= slot.x0 - SNAP_PX && c.x1 <= slot.x1 + SNAP_PX));
  const at = (price) => map.A + map.B * price;
  // Un globo de resultado del mismo color encima de la casilla no es la vela (Argon): si lo visto se sale mucho de
  // lo que el bot dice que ha recorrido la vela, se dibuja con los precios del bot.
  const slack = Math.max(8, (fit ? fit.tolerance : 2) * 3);
  const plausible = (c) => c.high <= at(forming.high) + slack && c.low >= at(forming.low) - slack;
  const fits = here.filter(plausible);
  const visible = fits.length ? fits[fits.length - 1] : null;
  const current = visible
    ? { x0: visible.x0, x1: visible.x1, open: visible.open, close: visible.close, high: visible.high, low: visible.low, up: visible.dir !== 'down', seen: true }
    : { x0: slot.x0, x1: slot.x1, open: at(forming.open), close: at(forming.close), high: at(forming.high), low: at(forming.low), up: forming.close >= forming.open, seen: false };
  const marks = seen.filter((c) => c.x1 < slot.x0 - 1); // solo las cerradas (lo que quede a la derecha de la casilla es un globo o un aviso)
  const debug = { shift: fit ? fit.shift : null, rms: fit ? fit.rms : null, n: fit ? fit.n : null, tolerance: fit ? fit.tolerance : null, pitch, held: !fit, seen: Boolean(visible) };
  return { marks, current, seconds, debug, track: { slot, map, pitch: pitch || (prev && prev.pitch) || 0, fitAt: fit ? now : prev.fitAt, seconds, lead }, exact: true };
}

module.exports = { trackZone, pitchOf, widerBooks, HOLD_MS };
