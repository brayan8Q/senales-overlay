/**
 * Resultados que marca la propia plataforma sobre la grafica.
 *
 * Al cerrar una operacion la plataforma dibuja un globo: etiqueta negra con el
 * importe en blanco ("$0", "+$1.75") y, a su derecha, un circulo con palomita:
 * VERDE si la operacion se gano, ROJO si se perdio y AMARILLO si quedo en empate
 * (la plataforma devuelve lo apostado: "+$2").
 *
 * Aqui se localizan esos globos en la imagen y se cuentan una sola vez cada
 * uno. Es el resultado real de las operaciones del usuario, no una estimacion.
 *
 * Funciones puras (pixeles RGBA y listas).
 */

const isGreen = (r, g, b) => g > 100 && g - r > 40 && g - b > 40;
const isRed = (r, g, b) => r > 140 && r - g > 70 && r - b > 70;
const isYellow = (r, g, b) => r > 190 && g > 130 && b < 110 && r - b > 100; // amarillo del empate (240, 208, 16)
const isBlack = (r, g, b) => r < 30 && g < 30 && b < 30; // el fondo de la grafica es azul oscuro, no negro
const isWhite = (r, g, b) => r > 190 && g > 190 && b > 190;

/**
 * Busca globos de resultado en la imagen.
 * @returns {Array<{x:number, y:number, result:'win'|'loss'|'tie'}>}  (x, y = centro de la etiqueta)
 */
function findResultBadges(rgba, width, height) {
  const at = (x, y) => {
    const p = (y * width + x) * 4;
    return [rgba[p], rgba[p + 1], rgba[p + 2]];
  };
  const seen = new Uint8Array(width * height);
  const badges = [];
  const stack = [];

  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue;
    const sx = start % width;
    const sy = (start - sx) / width;
    if (!isBlack(...at(sx, sy))) continue;

    // Mancha negra conexa (la etiqueta).
    let x0 = sx;
    let x1 = sx;
    let y0 = sy;
    let y1 = sy;
    let count = 0;
    stack.push(sx, sy);
    seen[start] = 1;
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const k = ny * width + nx;
        if (seen[k] || !isBlack(...at(nx, ny))) continue;
        seen[k] = 1;
        stack.push(nx, ny);
      }
    }

    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (h < 12 || h > 34 || w < 24 || w > 160 || w < h) continue;
    if (count / (w * h) < 0.5) continue;

    // Debe llevar texto blanco dentro (el importe).
    let white = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (isWhite(...at(x, y))) white++;
    }
    const textShare = white / (w * h);
    if (textShare < 0.015 || textShare > 0.35) continue;

    // Y un circulo de color pegado a la derecha: verde = ganada, rojo = perdida, amarillo = empate.
    let green = 0;
    let red = 0;
    let yellow = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x1 + 1; x <= Math.min(width - 1, x1 + h); x++) {
        total++;
        const [r, g, b] = at(x, y);
        if (isGreen(r, g, b)) green++;
        else if (isRed(r, g, b)) red++;
        else if (isYellow(r, g, b)) yellow++;
      }
    }
    if (total === 0) continue;
    let result = null;
    if (green / total >= 0.3 && green >= (red + yellow) * 3) result = 'win';
    else if (red / total >= 0.3 && red >= (green + yellow) * 3) result = 'loss';
    else if (yellow / total >= 0.3 && yellow >= (green + red) * 3) result = 'tie';
    if (!result) continue;

    badges.push({ x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2), result });
  }
  return badges;
}

/**
 * True si la vista de la grafica salto entre dos lecturas (zoom, cambio de
 * escala o de activo). El desplazamiento lento normal no cuenta como salto.
 */
function viewJumped(previous, current) {
  if (!previous || previous.length === 0) return true;
  let same = 0;
  for (const p of previous) {
    const match = current.some(
      (c) => Math.abs(c.x0 - p.x0) <= 2 && Math.abs(c.high - p.high) <= 2 && Math.abs(c.low - p.low) <= 2,
    );
    if (match) same++;
  }
  return same < previous.length * 0.6;
}

const MATCH_DISTANCE = 14; // px: un globo es "el mismo" si casi no se movio entre lecturas
const FORGET_AFTER_MS = 8000;
const FRAMES_TO_COUNT = 2; // debe verse en dos lecturas seguidas (evita destellos)
const RECENT_MS = 1500; // tras un salto, solo cuentan como "ya estaban" los vistos hace este tiempo o menos

/** Cuenta cada globo de resultado una sola vez. */
function createBadgeCounter() {
  const tally = { wins: 0, losses: 0, ties: 0 };
  let known = []; // { x, y, result, frames, lastSeen, counted }
  let needsRebase = true; // al empezar, lo que ya esta en pantalla no se cuenta
  let last = '';

  return {
    /**
     * @param {Array} badges   Globos vistos en esta lectura.
     * @param {number} now     Reloj en ms.
     * @param {boolean} jumped True si la vista salto respecto a la lectura anterior.
     */
    update(badges, now, jumped) {
      const count = (entry) => {
        entry.counted = true;
        if (entry.result === 'win') {
          tally.wins++;
          last = 'GANADA';
        } else if (entry.result === 'tie') {
          tally.ties++;
          last = 'EMPATE';
        } else {
          tally.losses++;
          last = 'PERDIDA';
        }
      };
      if (needsRebase) {
        // Al empezar (o tras reiniciar), los globos que ya estaban en pantalla se dan por contados.
        known = badges.map((b) => ({ ...b, frames: FRAMES_TO_COUNT, lastSeen: now, counted: true }));
        needsRebase = false;
        return { ...tally, last };
      }
      if (jumped) {
        // La vista salto (cambio de escala, cierre de vela, un aviso que tapa velas...) y los globos
        // cambiaron de sitio, asi que no se pueden reconocer por posicion. Antes aqui se daban todos
        // por ya contados, y eso se comia el globo nuevo: justo al cerrar una operacion la plataforma
        // tapa velas con su aviso "Trade closed" y eso parece un salto.
        // Ahora se emparejan por orden de izquierda a derecha (un salto no cambia el orden): los que
        // ya estaban conservan su estado y los que sobran por la derecha son nuevos.
        const recent = known.filter((k) => now - k.lastSeen <= RECENT_MS);
        const next = [];
        for (const result of ['win', 'loss', 'tie']) {
          const before = recent.filter((k) => k.result === result).sort((a, b) => a.x - b.x);
          const current = badges.filter((b) => b.result === result).sort((a, b) => a.x - b.x);
          // Si ahora hay menos, los que faltan son los de la izquierda (salieron de la vista).
          const skip = Math.max(0, before.length - current.length);
          current.forEach((badge, i) => {
            const old = before[i + skip];
            const entry = old
              ? { ...badge, frames: old.frames + 1, lastSeen: now, counted: old.counted }
              : { ...badge, frames: 1, lastSeen: now, counted: false };
            if (!entry.counted && entry.frames >= FRAMES_TO_COUNT) count(entry);
            next.push(entry);
          });
        }
        known = next;
        return { ...tally, last };
      }

      for (const badge of badges) {
        const match = known.find(
          (k) =>
            k.result === badge.result &&
            k.lastSeen !== now &&
            Math.abs(k.x - badge.x) <= MATCH_DISTANCE &&
            Math.abs(k.y - badge.y) <= MATCH_DISTANCE,
        );
        if (match) {
          match.x = badge.x;
          match.y = badge.y;
          match.frames++;
          match.lastSeen = now;
          if (!match.counted && match.frames >= FRAMES_TO_COUNT) count(match);
        } else {
          known.push({ ...badge, frames: 1, lastSeen: now, counted: false });
        }
      }
      known = known.filter((k) => now - k.lastSeen <= FORGET_AFTER_MS);
      return { ...tally, last };
    },

    reset() {
      tally.wins = 0;
      tally.losses = 0;
      tally.ties = 0;
      known = [];
      needsRebase = true;
      last = '';
    },
  };
}

module.exports = { findResultBadges, viewJumped, createBadgeCounter };
