/**
 * Genera src/digits.json: plantillas de los digitos 0-9 en varias tipografias,
 * pesos y tamanos, para leer los numeros del eje de precios (src/axis.js).
 *
 * Uso:  npx electron tools/build-digits.js
 *
 * Dibuja cada digito en un lienzo (texto blanco sobre negro), lo recorta y lo
 * lleva a la misma rejilla de 10x12 que usa el lector. Las tipografias que no
 * estan instaladas se saltan. Plantillas casi iguales no se repiten.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeGlyph, GRID_W, GRID_H } = require('../src/axis');

const FONTS = [
  'Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'Calibri', 'Trebuchet MS', 'Microsoft Sans Serif', 'Bahnschrift',
  'Candara', 'Corbel', 'Lucida Sans Unicode', 'Franklin Gothic Medium', 'Gadugi', 'Leelawadee UI', 'Nirmala UI',
  'Yu Gothic UI', 'Malgun Gothic', 'Consolas', 'Roboto', 'Open Sans', 'Inter', 'Helvetica', 'Noto Sans', 'Lato',
];
const WEIGHTS = [400, 500, 700];
const SIZES = [12, 13, 14, 15, 16, 18];
const DIGITS = '0123456789';

const PAGE_SCRIPT = `(async (FONTS, WEIGHTS, SIZES, DIGITS) => {
  const out = [];
  const canvas = document.createElement('canvas');
  canvas.width = 40; canvas.height = 40;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const available = FONTS.filter((f) => document.fonts.check('16px "' + f + '"'));
  for (const font of available) {
    for (const weight of WEIGHTS) {
      for (const size of SIZES) {
        for (const offset of [0, 0.5]) {
          for (const ch of DIGITS) {
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 40, 40);
            ctx.fillStyle = '#fff'; ctx.font = weight + ' ' + size + 'px "' + font + '"';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(ch, 10 + offset, 28 + offset);
            const data = ctx.getImageData(0, 0, 40, 40).data;
            const lum = [];
            for (let i = 0; i < 1600; i++) lum.push(Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3));
            out.push({ font, weight, size, ch, lum });
          }
        }
      }
    }
  }
  return { available, out };
})`;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html,<html><body></body></html>');
    const args = [FONTS, WEIGHTS, SIZES, DIGITS].map((v) => JSON.stringify(v)).join(', ');
    const { available, out } = await win.webContents.executeJavaScript(`${PAGE_SCRIPT}(${args})`);
    const result = [];
    for (const sample of out) {
      // Recorte: pixeles con algo de tinta.
      let x0 = 40;
      let x1 = -1;
      let y0 = 40;
      let y1 = -1;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
          if (sample.lum[y * 40 + x] >= 70) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) continue;
      const gw = x1 - x0 + 1;
      const gh = y1 - y0 + 1;
      const gray = new Float32Array(gw * gh);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) gray[y * gw + x] = sample.lum[(y0 + y) * 40 + x0 + x] / 255;
      const grid = normalizeGlyph(gray, gw, gh);
      const values = Array.from(grid, (v) => Math.round(v * 9));
      // No se repiten plantillas casi iguales del mismo digito.
      const same = result.some((t) => t.c === sample.ch && t.v.reduce((s, v, i) => s + Math.abs(v - values[i]), 0) / (9 * values.length) < 0.035);
      if (!same) result.push({ c: sample.ch, v: values });
    }
    const file = path.join(__dirname, '..', 'src', 'digits.json');
    fs.writeFileSync(file, '[\n' + result.map((t) => JSON.stringify(t)).join(',\n') + '\n]\n');
    console.log('tipografias usadas: ' + available.join(', '));
    console.log('plantillas: ' + result.length + ' (rejilla ' + GRID_W + 'x' + GRID_H + ') -> ' + file);
  } catch (e) {
    console.error('ERROR ' + e.stack);
  }
  app.exit(0);
});
