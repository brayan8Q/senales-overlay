/**
 * Memoria del mercado: como se ha comportado ESTE activo, vela a vela.
 *
 * Cada vela que cierra mientras el panel esta abierto se guarda en disco (por
 * activo y tamano de vela), asi la memoria se acumula entre sesiones. Con ella
 * se responde a preguntas como:
 *
 *   "Llevan 3 velas verdes seguidas. Las otras veces que paso eso en esta
 *    grafica, ¿la siguiente fue verde o roja?"
 *
 * Es estadistica real de lo visto, no una regla inventada. Vota en la senal
 * solo cuando hay suficientes casos y la diferencia no se explica por suerte
 * (z >= 2). Con pocos casos solo informa.
 *
 * De cada vela se guarda: cuando cerro, su color y su tamano relativo a lo
 * normal de ese momento (no hay precios reales que guardar: la escala de la
 * pantalla cambia).
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_RECORDS = 6000; // unas 25 horas de velas de 15 s
const MAX_STREAK = 6; // rachas de 6 o mas se cuentan juntas
const MIN_CASES = 12; // casos minimos para que la memoria vote
const Z_NEEDED = 2;
const Z_STRONG = 3;
const PERIODS = [5, 10, 15, 30, 60, 120, 180, 300, 600, 900]; // tamanos de vela posibles, en segundos
const COLOR = { u: 'verde', d: 'roja' };
const PLURAL = { u: 'verdes', d: 'rojas' };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};
const letter = (dir) => (dir === 'up' ? 'u' : dir === 'down' ? 'd' : 'f');

/** Cada cuanto cierra una vela (ms), segun las horas de cierre guardadas. 0 si aun no se sabe. */
function periodOf(records) {
  const deltas = [];
  for (let i = 1; i < records.length; i++) {
    const delta = records[i].t - records[i - 1].t;
    if (delta > 2000 && delta < 20 * 60 * 1000) deltas.push(delta);
  }
  return deltas.length >= 3 ? median(deltas.slice(-80)) : 0;
}

/** Tamano de vela "de catalogo" mas cercano (15 s, 30 s, 1 min...), en segundos. */
function periodBucket(periodMs) {
  if (!periodMs) return 0;
  return PERIODS.reduce((best, p) => (Math.abs(p * 1000 - periodMs) < Math.abs(best * 1000 - periodMs) ? p : best), PERIODS[0]);
}

/**
 * Tabla: para cada racha (1 a 6 velas del mismo color), cuantas veces la vela
 * siguiente siguio del mismo color y cuantas veces giro. Dos velas son seguidas
 * solo si entre sus cierres paso mas o menos una vela (no se cruzan los huecos
 * en los que el panel no estuvo mirando).
 * @returns {Object<string,{continued:number, reversed:number}>}  claves "u3", "d1"...
 */
function streakTable(records, periodMs = periodOf(records)) {
  const table = {};
  if (!periodMs) return table;
  const adjacent = (a, b) => {
    const delta = b.t - a.t;
    return delta >= periodMs * 0.5 && delta <= periodMs * 1.6;
  };
  let run = 0;
  for (let i = 0; i < records.length; i++) {
    const current = records[i];
    const previous = records[i - 1];
    const linked = previous && adjacent(previous, current);
    if (current.d === 'f') run = 0;
    else if (linked && previous.d === current.d) run++;
    else run = 1;
    const next = records[i + 1];
    if (run === 0 || !next || !adjacent(current, next) || next.d === 'f') continue;
    const key = current.d + Math.min(run, MAX_STREAK);
    const cell = (table[key] = table[key] || { continued: 0, reversed: 0 });
    if (next.d === current.d) cell.continued++;
    else cell.reversed++;
  }
  return table;
}

/** Racha actual: cuantas velas cerradas seguidas del mismo color hay al final. */
function currentStreak(candles) {
  if (!candles.length) return { dir: 'f', length: 0 };
  const dir = letter(candles[candles.length - 1].dir);
  if (dir === 'f') return { dir, length: 0 };
  let length = 0;
  for (let i = candles.length - 1; i >= 0 && letter(candles[i].dir) === dir; i--) length++;
  return { dir, length };
}

/**
 * Que dice la memoria sobre la situacion de ahora.
 * @param {Object} table     Tabla de `streakTable`.
 * @param {Array} candles    Velas cerradas a la vista (la ultima, la mas reciente).
 * @param {number} total     Velas guardadas en la memoria.
 * @returns {{ vote:number, text:string, cases:number, rate:number|null, data:object }}
 *   vote = votos para la vela que sigue (la que esta en curso): + arriba, - abajo.
 */
function situation(table, candles, total = 0) {
  const { dir, length } = currentStreak(candles);
  const rows = Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, cell]) => ({
      racha: `${key.slice(1)}${Number(key.slice(1)) >= MAX_STREAK ? ' o mas' : ''} ${Number(key.slice(1)) === 1 ? COLOR[key[0]] : PLURAL[key[0]]} seguidas`,
      la_siguiente_siguio_igual: cell.continued,
      la_siguiente_giro: cell.reversed,
    }));
  const base = { vote: 0, cases: 0, rate: null };
  if (!length) return { ...base, text: `${total} velas guardadas · la última vela no tiene color claro`, data: { velas_guardadas: total, tabla: rows } };
  const cell = table[dir + Math.min(length, MAX_STREAK)] || { continued: 0, reversed: 0 };
  const cases = cell.continued + cell.reversed;
  const streakText = `${length} ${length === 1 ? COLOR[dir] : PLURAL[dir]}${length === 1 ? '' : ' seguidas'}`;
  const data = {
    explicacion:
      'estadistica real de esta grafica, guardada vela a vela: cuantas veces, tras una racha como la actual, la vela siguiente ' +
      'siguio del mismo color o giro. Pesa mas cuantos mas casos tenga; con menos de 12 casos no concluyas nada',
    velas_guardadas: total,
    situacion_actual: streakText,
    casos_iguales_antes: cases,
    la_siguiente_siguio_igual: cell.continued,
    la_siguiente_giro: cell.reversed,
    tabla: rows,
  };
  if (cases === 0) return { ...base, text: `van ${streakText}: aún sin casos iguales`, data };
  const reversed = cell.reversed >= cell.continued;
  const share = Math.round((100 * Math.max(cell.reversed, cell.continued)) / cases);
  const opposite = dir === 'u' ? 'd' : 'u';
  const nextColor = COLOR[reversed ? opposite : dir];
  const text = `tras ${streakText}, la siguiente fue ${nextColor} ${Math.max(cell.reversed, cell.continued)} de ${cases} veces (${share} %)`;
  // ¿Se distingue de mitad y mitad? Solo entonces vota.
  const z = (Math.max(cell.reversed, cell.continued) - cases / 2) / Math.sqrt(cases / 4);
  let vote = 0;
  if (cases >= MIN_CASES && z >= Z_NEEDED) {
    const towardUp = reversed ? dir === 'd' : dir === 'u';
    vote = (towardUp ? 1 : -1) * (z >= Z_STRONG ? 2 : 1);
  }
  return { vote, cases, rate: share, text: vote ? text : `${text}${cases < MIN_CASES ? ' · pocos casos aún' : ' · sin ventaja clara'}`, data };
}

const slug = (asset) =>
  String(asset || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sin-nombre';

/**
 * Memoria en disco. Un archivo por activo y tamano de vela: memoria/<activo>_<segundos>s.csv
 * con una linea por vela: hora_de_cierre_ms,color(u/d/f),cuerpo,rango (tamanos relativos a lo normal).
 */
function createMarketMemory(directory) {
  let asset = 'sin-nombre';
  let records = []; // velas de este activo y tamano de vela (lo guardado + lo de esta sesion)
  let session = []; // velas de esta sesion mientras no se sabe el tamano de vela
  let bucket = 0; // tamano de vela ya identificado (segundos); 0 = todavia no
  let pending = []; // lineas por escribir
  let table = {};

  const file = () => path.join(directory, `${asset}_${bucket}s.csv`);
  const rebuild = () => {
    table = streakTable(records);
  };
  const load = () => {
    records = [];
    try {
      const lines = fs.readFileSync(file(), 'utf8').split(/\r?\n/).slice(-MAX_RECORDS);
      for (const line of lines) {
        const [t, d, b, r] = line.split(',');
        if (Number(t) > 0 && (d === 'u' || d === 'd' || d === 'f')) records.push({ t: Number(t), d, b: Number(b) || 0, r: Number(r) || 0 });
      }
    } catch {
      /* todavia no hay memoria de este activo */
    }
  };

  return {
    /** Cambia de activo: lo que se guarde a partir de ahora va a su propio archivo. */
    setAsset(name) {
      const next = slug(name);
      if (next === asset) return;
      this.flush();
      asset = next;
      records = [];
      session = [];
      bucket = 0;
      table = {};
    },

    /**
     * Anota una vela que acaba de cerrar.
     * @param {{dir:string, open:number, close:number, high:number, low:number}} candle
     * @param {number} time   Hora de cierre (ms).
     * @param {number} unit   Rango tipico de una vela en este momento (para guardar tamanos relativos).
     */
    add(candle, time, unit) {
      const size = unit > 0 ? unit : 1;
      const record = {
        t: Math.round(time),
        d: letter(candle.dir),
        b: Math.round((10 * Math.abs(candle.close - candle.open)) / size) / 10,
        r: Math.round((10 * (candle.high - candle.low)) / size) / 10,
      };
      if (!bucket) {
        // Aun no se sabe de cuantos segundos son las velas: se espera a ver unas cuantas.
        session.push(record);
        const found = periodBucket(periodOf(session));
        if (!found) return;
        bucket = found;
        load();
        const lastSaved = records.length ? records[records.length - 1].t : 0;
        const fresh = session.filter((r) => r.t > lastSaved);
        records.push(...fresh);
        pending.push(...fresh);
        session = [];
      } else {
        records.push(record);
        pending.push(record);
      }
      if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
      rebuild();
    },

    /** Lo que dice la memoria sobre la situacion actual (ver `situation`). */
    stats(candles) {
      const known = bucket ? records : session;
      const info = situation(bucket ? table : streakTable(session), candles, known.length);
      return { ...info, total: known.length, candleSeconds: bucket };
    },

    count: () => (bucket ? records.length : session.length),

    /** Escribe en disco lo pendiente. */
    flush() {
      if (!bucket || pending.length === 0) return;
      const lines = pending.map((r) => `${r.t},${r.d},${r.b},${r.r}`).join('\n') + '\n';
      pending = [];
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.appendFileSync(file(), lines, 'utf8');
      } catch {
        /* la memoria no es critica */
      }
    },
  };
}

module.exports = { createMarketMemory, streakTable, situation, currentStreak, periodOf, periodBucket, slug, MIN_CASES };
