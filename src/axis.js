/**
 * Lee los numeros del eje de precios (la columna de la derecha de la grafica).
 *
 * Con dos o mas numeros del eje y la fila en la que esta cada uno se sabe cuanto
 * vale cada pixel, y entonces las distancias se pueden dar en pips en vez de en
 * "velas". Tambien da el precio actual (la fila de la linea del precio).
 *
 * Como lee:
 *   1. Mira solo la franja derecha de la zona (ahi esta el eje).
 *   2. Separa los renglones de texto y, en cada uno, los caracteres.
 *   3. Cada caracter se compara con plantillas de digitos de varias tipografias
 *      (src/digits.json) y se queda con la mas parecida.
 *   4. Se valida: los numeros del eje van a pasos iguales, asi que precio y fila
 *      tienen que caer en una recta. Lo que no cuadra se descarta. Si no hay al
 *      menos dos numeros que cuadren, no se da escala (el panel sigue en "velas").
 *
 * Las etiquetas con fondo (precio actual, alertas) no son parte del eje y se ignoran.
 *
 * Funciones puras sobre pixeles RGBA.
 */
const GRID_W = 10;
const GRID_H = 12;
const STRIP_PX = 110; // ancho de la franja derecha donde se busca el eje
const BLOCK = 16; // tamano del bloque para estimar el fondo
const MIN_CONTRAST = 35; // cuanto mas claro que el fondo debe ser un pixel de texto
const MAX_DISTANCE = 0.2; // parecido minimo con una plantilla (0 = identico)

/** Verde o rojo de vela (mismos umbrales que candles.js). */
const isCandleColor = (r, g, b) => (g > 100 && g - r > 40 && g - b > 40) || (r > 140 && r - g > 70 && r - b > 70);

let templates = null;
function loadTemplates() {
  if (!templates) {
    try {
      // eslint-disable-next-line global-require
      templates = require('./digits.json').map((t) => ({ char: t.c, values: Float32Array.from(t.v, (n) => n / 9) }));
    } catch {
      templates = [];
    }
  }
  return templates;
}

/**
 * Lleva un caracter (intensidades 0..1, ancho gw, alto gh) a una rejilla fija de 10x12,
 * conservando su proporcion (un "1" sigue siendo angosto) y centrado.
 */
function normalizeGlyph(gray, gw, gh) {
  const out = new Float32Array(GRID_W * GRID_H);
  const scale = GRID_H / gh;
  const width = Math.max(1, Math.min(GRID_W, Math.round(gw * scale)));
  const offset = Math.floor((GRID_W - width) / 2);
  for (let ty = 0; ty < GRID_H; ty++) {
    const y0 = (ty * gh) / GRID_H;
    const y1 = ((ty + 1) * gh) / GRID_H;
    for (let tx = 0; tx < width; tx++) {
      const x0 = (tx * gw) / width;
      const x1 = ((tx + 1) * gw) / width;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const hy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          sum += gray[y * gw + x] * wx * hy;
          area += wx * hy;
        }
      }
      out[ty * GRID_W + offset + tx] = area ? sum / area : 0;
    }
  }
  return out;
}

/** Digito mas parecido a una rejilla normalizada: { char, distance } (distance 0 = identico). */
function classify(grid) {
  // Los numeros del eje casi no cambian de una lectura a la siguiente: se recuerda el resultado
  // de cada forma ya vista, y asi leer el eje en cada lectura de pantalla cuesta casi nada.
  let key = '';
  for (let i = 0; i < grid.length; i++) key += Math.round(grid[i] * 9);
  const known = classifyCache.get(key);
  if (known) return known;
  const found = classifyUncached(grid);
  if (classifyCache.size > 3000) classifyCache.clear();
  classifyCache.set(key, found);
  return found;
}
const classifyCache = new Map();

function classifyUncached(grid) {
  let best = { char: '?', distance: Infinity };
  for (const t of loadTemplates()) {
    let d = 0;
    for (let i = 0; i < grid.length; i++) d += Math.abs(grid[i] - t.values[i]);
    d /= grid.length;
    if (d < best.distance) best = { char: t.char, distance: d };
  }
  return best;
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/**
 * Renglones de texto de la franja derecha, ya leidos.
 * @returns {Array<{y:number, text:string, worst:number}>}  y = fila del centro del renglon.
 */
function readLabels(rgba, width, height, minX = 0) {
  // La franja empieza despues de la ultima vela (minX), para que una vela no se mezcle con el texto.
  const x0 = Math.min(width - 1, Math.max(0, width - STRIP_PX, Math.round(minX)));
  const sw = width - x0;
  if (sw < 30) return [];
  const lum = new Float32Array(sw * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < sw; x++) {
      const p = (y * width + x0 + x) * 4;
      // Lo verde o rojo (velas, marcas de operaciones) no es texto del eje: se trata como fondo.
      lum[y * sw + x] = isCandleColor(rgba[p], rgba[p + 1], rgba[p + 2]) ? 0 : (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
    }
  }
  // Fondo por bloques: el percentil 25 de cada bloque (el texto ocupa poca parte del bloque).
  const bw = Math.ceil(sw / BLOCK);
  const bh = Math.ceil(height / BLOCK);
  const background = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const values = [];
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(sw, (bx + 1) * BLOCK); x++) values.push(lum[y * sw + x]);
      }
      background[by * bw + bx] = percentile(values, 0.25);
    }
  }
  const usual = percentile(Array.from(background), 0.5); // fondo normal del eje (oscuro)
  const bgAt = (x, y) => background[Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)];
  // Pixel de texto: mas claro que su fondo, y su fondo es el del eje (no una etiqueta con relleno).
  const bright = (x, y) => {
    const bg = bgAt(x, y);
    return bg <= usual + 22 && lum[y * sw + x] - bg >= MIN_CONTRAST;
  };
  // Una raya vertical (linea de expiracion, borde) enciende la misma columna en muchas filas: no es texto.
  const lineColumn = new Uint8Array(sw);
  for (let x = 0; x < sw; x++) {
    let n = 0;
    for (let y = 0; y < height; y++) if (bright(x, y)) n++;
    if (n > height * 0.25) lineColumn[x] = 1;
  }
  const isText = (x, y) => !lineColumn[x] && bright(x, y);

  // Renglones: filas seguidas con texto, de la altura de un numero.
  const rowHas = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < sw; x++) if (isText(x, y)) n++;
    rowHas[y] = n >= 2 && n <= sw * 0.6 ? 1 : 0; // una raya que cruza todo no es texto
  }
  const bands = [];
  for (let y = 0; y < height; y++) {
    if (!rowHas[y]) continue;
    const start = y;
    while (y < height && rowHas[y]) y++;
    if (y - start >= 7 && y - start <= 22) bands.push({ y0: start, y1: y - 1 });
  }

  const labels = [];
  for (const band of bands) {
    const bandH = band.y1 - band.y0 + 1;
    // Brillo del texto en este renglon, para pasar cada pixel a intensidad 0..1.
    const lit = [];
    for (let y = band.y0; y <= band.y1; y++) for (let x = 0; x < sw; x++) if (isText(x, y)) lit.push(lum[y * sw + x] - bgAt(x, y));
    const peak = percentile(lit, 0.9) || 1;
    const ink = (x, y) => (isText(x, y) ? Math.min(1, (lum[y * sw + x] - bgAt(x, y)) / peak) : 0);
    // Caracteres: columnas seguidas con tinta. Los digitos van muy juntos (1 px de separacion,
    // y ese pixel queda a medio tono por el suavizado), asi que una columna solo cuenta si
    // tiene al menos un pixel bien marcado.
    const colHas = new Uint8Array(sw);
    for (let x = 0; x < sw; x++) {
      for (let y = band.y0; y <= band.y1; y++) {
        if (ink(x, y) >= 0.55) {
          colHas[x] = 1;
          break;
        }
      }
    }
    const runs = [];
    for (let x = 0; x < sw; x++) {
      if (!colHas[x]) continue;
      const start = x;
      while (x < sw && colHas[x]) x++;
      runs.push({ x0: start, x1: x - 1 });
    }
    // Dos o tres digitos pegados salen como un solo tramo ancho: se parte por donde hay menos tinta.
    const pitch = bandH * 0.78; // ancho de un digito mas su separacion, respecto a su alto
    const columnInk = (x) => {
      let sum = 0;
      for (let y = band.y0; y <= band.y1; y++) sum += ink(x, y);
      return sum;
    };
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const w = run.x1 - run.x0 + 1;
      const pieces = Math.round(w / pitch);
      if (w < pitch * 1.5 || pieces < 2) continue;
      const parts = [];
      let start = run.x0;
      for (let j = 1; j < pieces; j++) {
        const expected = run.x0 + (j * w) / pieces;
        let cut = Math.round(expected);
        for (let x = Math.round(expected) - 2; x <= Math.round(expected) + 2; x++) {
          if (x > start + 1 && x < run.x1 - 1 && columnInk(x) < columnInk(cut)) cut = x;
        }
        parts.push({ x0: start, x1: cut - 1 });
        start = cut + 1;
      }
      parts.push({ x0: start, x1: run.x1 });
      runs.splice(i, 1, ...parts);
      i += parts.length - 1;
    }
    if (runs.length < 3 || runs.length > 12) continue;

    let text = '';
    let textTop = band.y1;
    let textBottom = band.y0;
    const detail = []; // para diagnostico: caracter, parecido y tamano de cada uno
    let worst = 0;
    let previousEnd = null;
    const gaps = [];
    for (let i = 1; i < runs.length; i++) gaps.push(runs[i].x0 - runs[i - 1].x1 - 1);
    const usualGap = gaps.length ? percentile(gaps, 0.5) : 0;
    for (const run of runs) {
      // Alto real del caracter dentro del renglon.
      let top = band.y1;
      let bottom = band.y0;
      for (let y = band.y0; y <= band.y1; y++) {
        for (let x = run.x0; x <= run.x1; x++) {
          if (ink(x, y) >= 0.35) {
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      if (bottom < top) continue;
      const gw = run.x1 - run.x0 + 1;
      const gh = bottom - top + 1;
      // Un hueco mucho mayor que lo normal es el punto decimal, aunque el punto casi no se vea.
      const gap = previousEnd === null ? 0 : run.x0 - previousEnd - 1;
      previousEnd = run.x1;
      if (gh <= bandH * 0.4) {
        // Caracter bajito pegado abajo: el punto decimal.
        if (bottom >= band.y1 - 2 && !text.includes('.')) text += '.';
        continue;
      }
      if (gap >= usualGap * 2 + 2 && !text.includes('.') && text.length) text += '.';
      const gray = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const sx = run.x0 + x;
          const sy = top + y;
          gray[y * gw + x] = Math.max(0, Math.min(1, (lum[sy * sw + sx] - bgAt(sx, sy)) / peak));
        }
      }
      const found = classify(normalizeGlyph(gray, gw, gh));
      worst = Math.max(worst, found.distance);
      text += found.distance <= MAX_DISTANCE ? found.char : '?';
      detail.push(`${found.char}:${found.distance.toFixed(2)}(${gw}x${gh})`);
      if (top < textTop) textTop = top;
      if (bottom > textBottom) textBottom = bottom;
    }
    if (textBottom < textTop) continue;
    labels.push({ y: (textTop + textBottom) / 2, text, worst, detail: detail.join(' ') });
  }
  return labels;
}

/** Tamano de un pip segun los decimales de la cotizacion (1.20573 -> 0.0001; 153.123 -> 0.01). */
function pipSize(decimals) {
  if (decimals >= 4) return 0.0001;
  if (decimals >= 2) return 0.01;
  return 10 ** -decimals;
}

/**
 * Escala del eje a partir de los renglones leidos.
 * @returns {{ perPixel:number, at:(row:number)=>number, decimals:number, pip:number, labels:number }|null}
 */
function fitScale(labels) {
  const points = labels
    .filter((l) => /^\d+\.\d+$/.test(l.text))
    .map((l) => ({ y: l.y, value: Number(l.text), decimals: l.text.split('.')[1].length }));
  if (points.length < 2) return null;
  // Entre todas las parejas se busca la recta con la que cuadran mas numeros.
  let best = null;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = (points[j].value - points[i].value) / (points[j].y - points[i].y);
      if (!(a < 0)) continue; // mas arriba en pantalla = precio mayor
      const b = points[i].value - a * points[i].y;
      const inliers = points.filter((p) => Math.abs((p.value - b) / a - p.y) <= 2 && p.decimals === points[i].decimals);
      if (!best || inliers.length > best.inliers.length) best = { a, b, inliers };
    }
  }
  if (!best) return null;
  if (best.inliers.length === 2) {
    // Con solo dos numeros no hay tercero que confirme: se exige que el paso sea "redondo" (1, 2, 2.5 o 5).
    const step = Math.abs(best.inliers[0].value - best.inliers[1].value);
    const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
    if (![1, 2, 2.5, 5].some((m) => Math.abs(mantissa - m) < 0.01)) return null;
  }
  // Recta final con todos los que cuadran (minimos cuadrados).
  const n = best.inliers.length;
  const meanY = best.inliers.reduce((s, p) => s + p.y, 0) / n;
  const meanV = best.inliers.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of best.inliers) {
    num += (p.y - meanY) * (p.value - meanV);
    den += (p.y - meanY) * (p.y - meanY);
  }
  const a = num / den;
  const b = meanV - a * meanY;
  const decimals = best.inliers[0].decimals;
  return { perPixel: -a, at: (row) => a * row + b, decimals, pip: pipSize(decimals), labels: n, rows: best.inliers.map((p) => p.y) };
}

/**
 * Filas de las lineas horizontales de la cuadricula: son 1 px mas claras que sus dos filas
 * vecinas en casi todo el ancho de la zona (tambien salen la linea del precio y las alertas).
 */
function findGridLines(rgba, width, height) {
  const lum = (x, y) => {
    const p = (y * width + x) * 4;
    return rgba[p] + rgba[p + 1] + rgba[p + 2];
  };
  const candle = (x, y) => {
    const p = (y * width + x) * 4;
    return isCandleColor(rgba[p], rgba[p + 1], rgba[p + 2]);
  };
  const rows = [];
  for (let y = 1; y < height - 1; y++) {
    let hits = 0;
    let counted = 0;
    for (let x = 0; x < width; x++) {
      // Las velas tapan la cuadricula: esas columnas no cuentan ni a favor ni en contra.
      if (candle(x, y) || candle(x, y - 1) || candle(x, y + 1)) continue;
      counted++;
      const here = lum(x, y);
      if (here - lum(x, y - 1) >= 6 && here - lum(x, y + 1) >= 6) hits++; // 6 = 2 niveles por canal
    }
    if (counted >= width * 0.3 && hits >= counted * 0.8) rows.push(y);
  }
  return rows;
}

/**
 * La plataforma dibuja cada numero del eje un poco ARRIBA de su linea, no encima. Aqui se
 * busca ese desfase: el que hace coincidir mas numeros con una linea de la cuadricula.
 * @returns {number|null}  Pixeles que hay que sumar a la fila del numero para llegar a su linea.
 */
function labelOffset(scale, gridRows) {
  if (!scale || gridRows.length < 2) return null;
  let best = { offset: null, matched: 0, error: Infinity };
  for (let offset = -30; offset <= 30; offset += 0.5) {
    let matched = 0;
    let error = 0;
    for (const y of scale.rows) {
      const nearest = Math.min(...gridRows.map((g) => Math.abs(g - (y + offset))));
      if (nearest <= 1) {
        matched++;
        error += nearest;
      }
    }
    if (matched > best.matched || (matched === best.matched && matched > 0 && error < best.error)) best = { offset, matched, error };
  }
  // Tienen que coincidir al menos dos numeros, y la mayoria de los leidos.
  return best.matched >= 2 && best.matched >= scale.rows.length - 1 ? best.offset : null;
}

/**
 * Lee el eje de precios de la imagen de la zona.
 * @returns {{ perPixel:number, pip:number, decimals:number, labels:number, anchored:boolean,
 *             at:(row:number)=>number|null }|null}
 *   perPixel = precio por pixel (siempre que hay escala). `at(fila)` da el precio de una fila,
 *   o null si no se pudo anclar a la cuadricula (entonces solo sirven las distancias).
 */
function readAxis(rgba, width, height, minX = 0) {
  if (loadTemplates().length === 0) return null;
  const scale = fitScale(readLabels(rgba, width, height, minX));
  if (!scale) return null;
  const offset = labelOffset(scale, findGridLines(rgba, width, height));
  const raw = scale.at;
  return {
    perPixel: scale.perPixel,
    pip: scale.pip,
    decimals: scale.decimals,
    labels: scale.labels,
    anchored: offset !== null,
    at: (row) => (offset === null ? null : raw(row - offset)),
    // Al reves: en que fila de la imagen cae un precio (para dibujar una linea en ese precio).
    rowOf: (price) => (offset === null ? null : (price - raw(0)) / -scale.perPixel + offset),
  };
}

module.exports = { readAxis, readLabels, fitScale, findGridLines, labelOffset, pipSize, normalizeGlyph, classify, GRID_W, GRID_H };
