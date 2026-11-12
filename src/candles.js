/**
 * Lee las velas de la imagen de una grafica (velas verdes = suben, rojas = bajan).
 *
 * Metodo: se recorre la imagen por columnas. En cada columna se anotan los
 * pixeles verdes y rojos; las columnas seguidas del mismo color forman una
 * vela. El cuerpo es la altura tipica de sus columnas y las mechas son los
 * extremos.
 *
 * Los precios se devuelven en "pixeles de altura" (mas alto = mayor precio).
 * No son precios reales, pero bastan para tendencia, medias y RSI, que solo
 * dependen de la forma de la grafica.
 *
 * Funciones puras sobre pixeles RGBA.
 */

const isGreen = (r, g, b) => g > 100 && g - r > 40 && g - b > 40;
const isRed = (r, g, b) => r > 140 && r - g > 70 && r - b > 70;
const MAX_GAP = 3; // hueco (px) que no corta una vela: lineas finas que pasan por encima

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * @returns {Array<{x0:number,x1:number,dir:'up'|'down'|'flat',open:number,close:number,high:number,low:number}>}
 *   Velas de izquierda a derecha. La ultima suele ser la que esta en curso.
 */
const GREEN = 1;
const RED = 2;
const LINE_THICKNESS = 3; // grosor maximo (px) de la linea de una operacion abierta

/** Por columna y color: cuantos pixeles hay, el mas alto, el mas bajo y el tramo seguido mas largo. */
function scanColumns(mask, width, height) {
  // Se guarda el TRAMO SEGUIDO mas largo de cada columna (segTop..segBot). Un hueco de hasta
  // 3 px no corta el tramo (la linea del precio o la cuadricula pasan por encima de las velas),
  // pero uno mayor si: asi la rayita que la plataforma dibuja en el precio de una operacion
  // abierta, separada de la vela, no se toma como parte de ella.
  const newSlot = () => ({ n: 0, top: -1, bot: -1, segTop: -1, segBot: -1, segN: 0, curTop: -1, curBot: -1, curN: 0 });
  const cols = new Array(width);
  for (let x = 0; x < width; x++) {
    const col = { g: newSlot(), r: newSlot() };
    for (let y = 0; y < height; y++) {
      const c = mask[y * width + x];
      if (!c) continue;
      const slot = c === GREEN ? col.g : col.r;
      if (slot.n === 0) slot.top = y;
      slot.bot = y;
      slot.n++;
      if (slot.curTop === -1 || y - slot.curBot > MAX_GAP + 1) {
        slot.curTop = y; // empieza otro tramo
        slot.curN = 0;
      }
      slot.curBot = y;
      slot.curN++;
      if (slot.segTop === -1 || slot.curBot - slot.curTop > slot.segBot - slot.segTop) {
        slot.segTop = slot.curTop;
        slot.segBot = slot.curBot;
        slot.segN = slot.curN;
      }
    }
    cols[x] = col;
  }
  return cols;
}

/** Columnas seguidas del mismo color = una vela. */
function findRuns(cols, width) {
  const colorAt = (x) => {
    const { g, r } = cols[x];
    if (g.n === 0 && r.n === 0) return null;
    return g.n >= r.n ? 'g' : 'r';
  };
  const runs = [];
  let x = 0;
  while (x < width) {
    const color = colorAt(x);
    if (!color) {
      x++;
      continue;
    }
    const start = x;
    while (x < width && colorAt(x) === color) x++;
    runs.push({ x0: start, x1: x - 1, color });
  }
  return runs;
}

/**
 * Una mancha mas ancha que una vela suele ser dos velas unidas por algo ajeno: los avisos de la
 * plataforma ("Trade order placed") traen iconos verdes que caen en las columnas del hueco entre
 * dos velas, mas abajo. Se separa donde las columnas vecinas dejan de estar a la misma altura.
 * (Solo se aplica a las manchas anchas: una vela normal no se toca.)
 */
function splitWideRuns(runs, cols, usualWidth) {
  const out = [];
  for (const run of runs) {
    if (run.x1 - run.x0 + 1 <= usualWidth * 1.4) {
      out.push(run);
      continue;
    }
    const slot = (x) => (run.color === 'g' ? cols[x].g : cols[x].r);
    const touching = (a, b) => a.segTop <= b.segBot + 1 && b.segTop <= a.segBot + 1;
    let start = run.x0;
    for (let x = run.x0 + 1; x <= run.x1 + 1; x++) {
      if (x <= run.x1 && touching(slot(x - 1), slot(x))) continue;
      out.push({ x0: start, x1: x - 1, color: run.color });
      start = x;
    }
  }
  return out;
}

/**
 * Borra la LINEA DE UNA OPERACION ABIERTA: la raya fina, verde (compra) o roja (venta), que la
 * plataforma dibuja desde el punto de entrada hacia la derecha mientras dura la operacion.
 * Si no se quita, se pega a la vela en curso (y a la anterior, cuando cierra una vela) y el
 * lector ve una sola mancha anchisima en lugar de velas: se quedaba sin las dos ultimas velas
 * durante todo el minuto de la operacion.
 *
 * Una vela nunca toca a la de al lado, asi que una fila con color seguido a lo largo de mas de
 * una vela y media solo puede ser esa linea. De ella se borran los pixeles finos (los que no
 * forman parte de un cuerpo): donde la linea pasa por dentro de una vela, la vela queda intacta.
 *
 * @returns {boolean} true si borro algo.
 */
function eraseOrderLines(mask, width, height, minLength) {
  const thin = (x, y, c) => {
    let extent = 1;
    for (let k = 1; k <= LINE_THICKNESS && y - k >= 0 && mask[(y - k) * width + x] === c; k++) extent++;
    for (let k = 1; k <= LINE_THICKNESS && y + k < height && mask[(y + k) * width + x] === c; k++) extent++;
    return extent <= LINE_THICKNESS;
  };
  let erased = false;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      const c = mask[row + x];
      if (!c) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && mask[row + x] === c) x++;
      if (x - start < minLength) continue;
      const thinOnes = [];
      for (let cx = start; cx < x; cx++) if (thin(cx, y, c)) thinOnes.push(cx);
      if (thinOnes.length < 8) continue; // algo ancho y macizo (un boton, una etiqueta): no es la linea
      for (const cx of thinOnes) mask[row + cx] = 0;
      erased = true;
    }
  }
  return erased;
}

function readCandles(rgba, width, height) {
  // Que pixeles son de vela: verde o rojo.
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    if (isGreen(r, g, b)) mask[i] = GREEN;
    else if (isRed(r, g, b)) mask[i] = RED;
  }
  let cols = scanColumns(mask, width, height);
  let runs = findRuns(cols, width);

  // Linea de una operacion abierta: se quita y se vuelve a leer.
  {
    const widths = runs.map((run) => run.x1 - run.x0 + 1).filter((w) => w >= 3);
    if (widths.length) {
      const usual = median(widths);
      if (eraseOrderLines(mask, width, height, Math.max(12, Math.round(usual * 1.5)))) {
        cols = scanColumns(mask, width, height);
        runs = findRuns(cols, width);
      }
    }
  }

  // Una raya fina pegada a una vela (p. ej. la linea que la plataforma dibuja desde una
  // operacion abierta) no es parte de la vela: se recorta por los lados.
  for (const run of runs) {
    const count = (cx) => (run.color === 'g' ? cols[cx].g.n : cols[cx].r.n);
    const counts = [];
    for (let cx = run.x0; cx <= run.x1; cx++) counts.push(count(cx));
    counts.sort((a, b) => a - b);
    if (counts[Math.floor(counts.length * 0.75)] <= 6) continue; // todo es fino: no hay cuerpo que separar
    while (run.x1 > run.x0 && count(run.x1) <= 3) run.x1--;
    while (run.x0 < run.x1 && count(run.x0) <= 3) run.x0++;
  }

  // Dos velas unidas por un icono de un aviso: se separan.
  {
    const widths = runs.map((run) => run.x1 - run.x0 + 1).filter((w) => w >= 3);
    if (widths.length) runs = splitWideRuns(runs, cols, median(widths));
  }

  // Se descartan velas cortadas por el borde y manchas que no tienen ancho de vela.
  const inside = runs.filter((run) => run.x0 > 0 && run.x1 < width - 1 && run.x1 - run.x0 + 1 >= 3);
  if (inside.length === 0) return [];
  const typicalWidth = median(inside.map((run) => run.x1 - run.x0 + 1));
  const candleRuns = inside.filter((run) => {
    const w = run.x1 - run.x0 + 1;
    return w >= typicalWidth * 0.6 && w <= typicalWidth * 1.4;
  });

  return candleRuns
    .map((run) => {
    const tops = [];
    const bots = [];
    const fills = []; // parte de cada columna realmente pintada (1 = maciza)
    for (let cx = run.x0; cx <= run.x1; cx++) {
      const slot = run.color === 'g' ? cols[cx].g : cols[cx].r;
      if (slot.n === 0) continue;
      tops.push(slot.segTop);
      bots.push(slot.segBot);
      fills.push(slot.segN / (slot.segBot - slot.segTop + 1)); // dentro de la vela, no de toda la columna
    }
    // La mayoria de las columnas son solo cuerpo; la mecha ocupa 1-2 columnas.
    const bodyTop = median(tops);
    const bodyBot = median(bots);
    // Una vela tiene cuerpo recto: casi todas sus columnas empiezan (o terminan) a la
    // misma altura. Basta un borde recto, porque un globo de la plataforma puede tapar
    // el otro. Un icono redondo no tiene ningun borde recto.
    let straightTop = 0;
    let straightBottom = 0;
    for (let k = 0; k < tops.length; k++) {
      if (Math.abs(tops[k] - bodyTop) <= 1) straightTop++;
      if (Math.abs(bots[k] - bodyBot) <= 1) straightBottom++;
    }
    if (Math.max(straightTop, straightBottom) < tops.length * 0.7) return null;
    // Y es maciza: el contorno hueco de una etiqueta no es una vela.
    if (median(fills) < 0.6) return null;
    const high = -Math.min(...tops);
    const low = -Math.max(...bots);
    const up = run.color === 'g';
    return {
      x0: run.x0,
      x1: run.x1,
      dir: bodyTop === bodyBot ? 'flat' : up ? 'up' : 'down',
      open: up ? -bodyBot : -bodyTop,
      close: up ? -bodyTop : -bodyBot,
      high,
      low,
    };
    })
    .filter(Boolean);
}

/**
 * Localiza la linea horizontal del precio actual (la raya clara que cruza toda
 * la grafica). Devuelve su fila en pixeles, o null si no se distingue.
 *
 * `hintY` (opcional) es la fila donde cierra la vela en curso. Sirve para no
 * confundir la linea del precio con otras rayas parecidas (p. ej. la de una
 * orden pendiente): entre las candidatas se prefiere la que pasa por ahi.
 */
function findPriceLine(rgba, width, height, hintY = null) {
  // Brillo medio de cada fila, sin contar los pixeles de las velas.
  const brightness = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      if (isGreen(r, g, b) || isRed(r, g, b)) continue;
      sum += (r + g + b) / 3;
      n++;
    }
    brightness[y] = n ? sum / n : 0;
  }
  // Debe cruzar casi todo el ancho (una linea punteada o un texto no cuentan).
  const crossesChart = (y, around) => {
    let lit = 0;
    let total = 0;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      if (isGreen(r, g, b) || isRed(r, g, b)) continue;
      total++;
      if ((r + g + b) / 3 >= around + 20) lit++;
    }
    return total > 0 && lit >= total * 0.6;
  };

  // Candidatas: filas que destacan sobre las filas cercanas y cruzan la grafica.
  const lines = [];
  for (let y = 4; y < height - 4; y++) {
    const near = (brightness[y - 4] + brightness[y - 3] + brightness[y + 3] + brightness[y + 4]) / 4;
    const contrast = brightness[y] - near;
    if (contrast >= 25 && crossesChart(y, near)) lines.push({ y, contrast });
  }
  if (lines.length === 0) return null;

  // La del precio pasa por el cierre de la vela en curso.
  if (hintY !== null) {
    const close = lines
      .filter((line) => Math.abs(line.y - hintY) <= 4)
      .sort((a, b) => b.contrast - a.contrast)[0];
    if (close) return close.y;
  }
  return lines.sort((a, b) => b.contrast - a.contrast)[0].y;
}

/**
 * Localiza la etiqueta del precio actual: la caja azul que la plataforma dibuja sobre el eje
 * de precios, a la derecha, a la altura exacta del precio. Devuelve la fila de su centro, o
 * null si no esta a la vista (el eje no entra en la zona).
 *
 * Sirve para saber donde esta el precio aunque un globo o un aviso tape la vela en curso:
 * la etiqueta esta en el eje, lejos de las velas, y nada la tapa.
 */
function findPriceLabel(rgba, width, height) {
  const from = Math.max(0, width - LABEL_STRIP_PX);
  const isLabelBlue = (r, g, b) => b > 120 && b - r > 50 && b - g > 15;
  let best = null;
  let start = -1;
  for (let y = 0; y <= height; y++) {
    let blue = 0;
    if (y < height) {
      for (let x = from; x < width; x++) {
        const p = (y * width + x) * 4;
        if (isLabelBlue(rgba[p], rgba[p + 1], rgba[p + 2])) blue++;
      }
    }
    const inBox = blue >= LABEL_MIN_PX;
    if (inBox && start < 0) start = y;
    if (!inBox && start >= 0) {
      const rows = y - start;
      // Una caja de etiqueta mide entre 14 y 44 filas; se queda con la mas alta que cumpla.
      if (rows >= 14 && rows <= 44 && (!best || rows > best.rows)) best = { rows, center: (start + y - 1) / 2 };
      start = -1;
    }
  }
  return best ? best.center : null;
}
const LABEL_STRIP_PX = 90; // franja derecha donde se busca la etiqueta
const LABEL_MIN_PX = 30; // pixeles azules por fila para contarla como parte de la caja

module.exports = { readCandles, findPriceLine, findPriceLabel };
