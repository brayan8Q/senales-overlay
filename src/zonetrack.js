/**
 * SEGUIMIENTO DE LA VELA ACTUAL EN UNA ZONA (16 nov 2026).
 *
 * El usuario: «soluciona lo de la vela actual, el seguimiento, porque a veces regresa a una anterior». Pasaba
 * porque se tomaba como vela actual la mas a la derecha de las que el lector de pantalla encuentra por color: una
 * vela recien abierta (una raya), un doji, o una tapada por la linea de precio o por la marca de una operacion no
 * se detecta, y el recuadro saltaba a la anterior.
 *
 * Ahora la vela actual NO se adivina. El bot da las velas exactas del par (precios); aqui se casan con las que se
 * ven en la pantalla (src/pricemap.js: una recta precio → fila, probando si la ultima vista es la que va en curso
 * o la ultima cerrada) y la vela actual se dibuja con los precios del bot:
 *   - si la pantalla SI la ve, en su sitio;
 *   - si no la ve, un paso a la derecha de la ultima cerrada (paso = separacion entre velas);
 *   - si en una lectura nada cuadra (algo tapa la grafica), se sostiene el ultimo dibujo unos segundos y despues
 *     se quita: nunca se marca una vela anterior.
 * Ademas (idea de Argon): mientras dura una misma vela, su posicion no puede retroceder.
 */
const { fitPriceMap } = require('./pricemap');

const HOLD_MS = 4000; // cuanto se sostiene el ultimo dibujo si una lectura no cuadra
const SHORT_FIT = 9; // segundo intento: solo las ultimas velas (un doji viejo que el lector se salto no estorba)

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

const merge = (list) => ({ open: list[0].open, close: list[list.length - 1].close, high: Math.max(...list.map((c) => c.high)), low: Math.min(...list.map((c) => c.low)) });
/**
 * Las velas del bot (15 s) juntadas de `size` en `size`, como las pinta la plataforma con mas tiempo a la vista
 * (M10 = velas de 30 s). No se sabe en cual de las de 15 s empieza cada vela grande, asi que se dan todas las
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
 * @returns {{marks:Array, current:object|null, track:object|null, exact:boolean}}
 *   current = { x0, x1, open, close, high, low, up } en unidades de pantalla; exact = dibujada con precios del bot.
 */
function trackZone({ candles, book, prev = null, now }) {
  const seen = candles || [];
  if (!book || !book.forming || !book.closed || book.closed.length < 6) {
    // Sin velas del bot: lo de antes (la mas a la derecha), pero sin retroceder dentro de la misma lectura.
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
  let fit = tryFit(book);
  // Las de 15 s no casan: la grafica puede estar pintando velas de 30 s o de 1 min.
  for (const size of fit ? [] : [2, 4]) {
    for (const alt of widerBooks(book, size)) {
      const f = tryFit(alt);
      if (f && (!fit || f.rms < fit.rms)) {
        fit = f;
        used = alt;
      }
    }
    if (fit) break;
  }
  // Cuando empezo la vela en curso (reloj local): para saber si sigue siendo la misma que en la lectura anterior.
  const startedAt = now - (Number(book.openFor) || 0) * 1000;
  const sameCandle = prev && Math.abs(prev.startedAt - startedAt) < 3000;

  let geo = null;
  let map = null;
  let marks = seen;
  if (fit && fit.valid && seen.length) {
    const last = seen[seen.length - 1];
    map = { A: fit.A, B: fit.B };
    if (fit.shift === 1 && pitch > 0) {
      // La pantalla no ve la vela en curso: va un paso a la derecha de la ultima cerrada.
      geo = { x0: last.x0 + pitch, x1: last.x1 + pitch };
    } else {
      geo = { x0: last.x0, x1: last.x1 };
      marks = seen.slice(0, -1);
    }
    // Dentro de la misma vela la posicion no retrocede (un salto atras de medio paso o mas es una lectura mala).
    if (sameCandle && prev.geo && pitch > 0 && geo.x0 < prev.geo.x0 - pitch * 0.5) {
      geo = prev.geo;
      marks = seen.filter((c) => c.x1 < geo.x0);
    }
  } else if (prev && prev.geo && prev.map && now - prev.fitAt <= HOLD_MS) {
    // Esta lectura no cuadra: se sostiene el ultimo sitio y la ultima recta.
    geo = prev.geo; // la grafica se recorre sola: una vela nueva nace en el mismo sitio
    map = prev.map;
    marks = seen.filter((c) => c.x1 < geo.x0);
  }
  if (!geo || !map) return { marks: seen.slice(0, -1), current: null, track: null, exact: false };

  const at = (price) => map.A + map.B * price;
  // (si esta lectura no caso, se dibuja con la misma forma de juntar velas que la ultima vez)
  const seconds = fit ? used.seconds || 15 : (prev && prev.seconds) || 15;
  const again = !fit && seconds !== 15 ? widerBooks(book, seconds / 15).find((b) => b.lead === ((prev && prev.lead) || 0)) || null : null;
  const f = (fit ? used : again || book).forming;
  const current = { x0: geo.x0, x1: geo.x1, open: at(f.open), close: at(f.close), high: at(f.high), low: at(f.low), up: f.close >= f.open };
  const fitAt = fit && fit.valid ? now : prev.fitAt;
  return { marks, current, seconds, track: { geo, map, pitch: pitch || (prev && prev.pitch) || 0, fitAt, startedAt, seconds, lead: fit ? used.lead || 0 : (prev && prev.lead) || 0 }, exact: true };
}

module.exports = { trackZone, pitchOf, widerBooks, HOLD_MS };
