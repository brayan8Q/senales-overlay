/**
 * Memoria del mercado: como se ha comportado ESTE activo, vela a vela.
 *
 * Cada vela que cierra mientras el panel esta abierto se guarda en disco (por
 * activo y tamano de vela), asi la memoria se acumula entre sesiones. Con ella
 * se responde a dos preguntas:
 *
 *   1. Por vela completa: "Llevan 3 velas verdes seguidas. Las otras veces que
 *      paso eso aqui, ¿la siguiente fue verde o roja?"
 *   2. Por momento de la vela: cada vela se parte en tramos del tamano de la
 *      operacion (una vela de 15 s y operaciones de 5 s = 3 tramos). "Tras 3
 *      verdes seguidas, en el 2.º tramo de la vela, ¿el precio subio o bajo?"
 *      Esta encaja mejor con una operacion corta que la vela entera.
 *
 * Es estadistica real de lo visto, no una regla inventada. Vota en la senal
 * solo cuando hay suficientes casos y la diferencia no se explica por suerte
 * (z >= 2). Con pocos casos solo informa.
 *
 * De cada vela se guarda: cuando cerro, su color, su tamano relativo a lo
 * normal de ese momento y hacia donde se movio el precio en cada tramo (no hay
 * precios reales que guardar: la escala de la pantalla cambia).
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_RECORDS = 6000; // unas 25 horas de velas de 15 s
const MAX_STREAK = 6; // rachas de 6 o mas se cuentan juntas
const MAX_SEGMENTS = 6; // tramos por vela, como mucho
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
const streakWords = (dir, length) => `${length} ${length === 1 ? COLOR[dir] : PLURAL[dir]}${length === 1 ? '' : ' seguidas'}`;

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

/** En cuantos tramos se parte una vela para operaciones de `tradeSeconds` (entre 1 y 6). */
function segmentCount(candleSeconds, tradeSeconds) {
  if (!candleSeconds || !tradeSeconds) return 0;
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.round(candleSeconds / tradeSeconds)));
}

/**
 * Hacia donde se movio el precio en cada tramo de una vela: "udu" = subio, bajo, subio.
 * 'f' = casi no se movio; '?' = no hubo lectura del precio en ese momento.
 * @param {Array<{time:number,value:number}>} prices  Recorrido del precio (mayor = mas alto), por tiempo.
 * @param {number} tolerance  Movimiento minimo para contar (mismas unidades que `value`).
 */
function segmentsOf(prices, startTime, endTime, count, tolerance = 0.5) {
  if (!count || !prices.length) return '';
  const at = (time) => {
    let best = null;
    for (const p of prices) {
      if (!best || Math.abs(p.time - time) < Math.abs(best.time - time)) best = p;
    }
    return best && Math.abs(best.time - time) <= 700 ? best.value : null;
  };
  const step = (endTime - startTime) / count;
  let out = '';
  for (let j = 0; j < count; j++) {
    const a = at(startTime + j * step);
    const b = at(startTime + (j + 1) * step);
    if (a === null || b === null) out += '?';
    else out += Math.abs(b - a) < tolerance ? 'f' : b > a ? 'u' : 'd';
  }
  return out;
}

/**
 * Recorre las velas guardadas llevando la racha. Llama a `visit(record, racha anterior, siguiente)`
 * solo entre velas realmente seguidas (no se cruzan los huecos en los que el panel no miraba).
 */
function walk(records, periodMs, visit) {
  if (!periodMs) return;
  const adjacent = (a, b) => {
    const delta = b.t - a.t;
    return delta >= periodMs * 0.5 && delta <= periodMs * 1.6;
  };
  let run = 0; // racha que termina en la vela actual
  let runDir = 'f';
  for (let i = 0; i < records.length; i++) {
    const current = records[i];
    const previous = records[i - 1];
    const linked = Boolean(previous) && adjacent(previous, current);
    const before = linked && run > 0 ? { dir: runDir, length: run } : null; // racha ANTES de esta vela
    if (current.d === 'f') run = 0;
    else if (linked && runDir === current.d && run > 0) run++;
    else run = 1;
    runDir = current.d;
    const next = records[i + 1];
    visit(current, before, run > 0 ? { dir: runDir, length: run } : null, next && adjacent(current, next) ? next : null);
  }
}

/**
 * Tabla por vela completa: para cada racha (1 a 6 velas del mismo color), cuantas veces la
 * vela siguiente siguio del mismo color y cuantas veces giro.
 * @returns {Object<string,{continued:number, reversed:number}>}  claves "u3", "d1"...
 */
function streakTable(records, periodMs = periodOf(records)) {
  const table = {};
  walk(records, periodMs, (current, before, streak, next) => {
    if (!streak || !next || next.d === 'f') return;
    const key = streak.dir + Math.min(streak.length, MAX_STREAK);
    const cell = (table[key] = table[key] || { continued: 0, reversed: 0 });
    if (next.d === streak.dir) cell.continued++;
    else cell.reversed++;
  });
  return table;
}

/**
 * Tabla por momento de la vela: tras una racha (la que habia ANTES de la vela), en el tramo j de
 * la vela, cuantas veces el precio subio y cuantas bajo.
 * @returns {Object<string,{up:number, down:number}>}  claves "u3:3:1" = tras 3 verdes, velas de 3 tramos, tramo 1 (el segundo).
 */
function momentTable(records, periodMs = periodOf(records)) {
  const table = {};
  walk(records, periodMs, (current, before) => {
    if (!before || !current.s) return;
    for (let j = 0; j < current.s.length; j++) {
      const move = current.s[j];
      if (move !== 'u' && move !== 'd') continue;
      const key = `${before.dir}${Math.min(before.length, MAX_STREAK)}:${current.s.length}:${j}`;
      const cell = (table[key] = table[key] || { up: 0, down: 0 });
      if (move === 'u') cell.up++;
      else cell.down++;
    }
  });
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

/** ¿Se distingue de mitad y mitad? Devuelve los votos (0, 1 o 2) que merece la mayoria. */
function strength(major, cases) {
  if (cases < MIN_CASES) return 0;
  const z = (major - cases / 2) / Math.sqrt(cases / 4);
  return z >= Z_STRONG ? 2 : z >= Z_NEEDED ? 1 : 0;
}

/**
 * Que dice la memoria sobre la situacion de ahora, por vela completa.
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
  const streakText = streakWords(dir, length);
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
  const major = Math.max(cell.reversed, cell.continued);
  const share = Math.round((100 * major) / cases);
  const opposite = dir === 'u' ? 'd' : 'u';
  const nextColor = COLOR[reversed ? opposite : dir];
  const text = `tras ${streakText}, la siguiente fue ${nextColor} ${major} de ${cases} veces (${share} %)`;
  const votes = strength(major, cases);
  const towardUp = reversed ? dir === 'd' : dir === 'u';
  const vote = votes ? (towardUp ? 1 : -1) * votes : 0;
  return { vote, cases, rate: share, text: vote ? text : `${text}${cases < MIN_CASES ? ' · pocos casos aún' : ' · sin ventaja clara'}`, data };
}

/**
 * Que dice la memoria sobre el MOMENTO actual de la vela.
 * @param {Object} table    Tabla de `momentTable`.
 * @param {Array} candles   Velas cerradas a la vista.
 * @param {{elapsed:number, candleSeconds:number, tradeSeconds:number, formingDir:string}} clock
 *        elapsed = segundos que lleva la vela en curso.
 * @returns {{ vote:number, text:string, cases:number, data:object }|null}  null si no se puede saber el momento.
 */
function momentSituation(table, candles, clock) {
  if (!clock || !clock.candleSeconds || clock.elapsed === null || clock.elapsed === undefined) return null;
  const count = segmentCount(clock.candleSeconds, clock.tradeSeconds);
  if (!count) return null;
  const length = clock.candleSeconds / count; // segundos por tramo
  let streak = currentStreak(candles);
  // Tramo que empieza mas cerca de ahora: ahi cae la mayor parte de la operacion.
  let index = Math.round(clock.elapsed / length);
  if (index >= count) {
    // La operacion caera ya en la vela siguiente: la racha incluye la vela en curso tal como va.
    const forming = letter(clock.formingDir);
    if (forming === 'f') return null;
    streak = forming === streak.dir ? { dir: forming, length: streak.length + 1 } : { dir: forming, length: 1 };
    index = 0;
  }
  if (!streak.length) return null;
  const cell = table[`${streak.dir}${Math.min(streak.length, MAX_STREAK)}:${count}:${index}`] || { up: 0, down: 0 };
  const cases = cell.up + cell.down;
  const where = `tramo ${index + 1} de ${count} de la vela`;
  const streakText = streakWords(streak.dir, streak.length);
  const data = {
    explicacion:
      `cada vela se parte en ${count} tramos de ${Math.round(length)} s. Tras una racha como la actual y en este mismo tramo de la vela, ` +
      'cuantas veces el precio subio o bajo. Es la estadistica que mejor encaja con una operacion de esos segundos',
    racha_antes_de_la_vela: streakText,
    tramo: `${index + 1} de ${count}`,
    casos: cases,
    subio: cell.up,
    bajo: cell.down,
  };
  if (cases === 0) return { vote: 0, cases, text: `tras ${streakText}, ${where}: aún sin casos`, data };
  const up = cell.up >= cell.down;
  const major = Math.max(cell.up, cell.down);
  const share = Math.round((100 * major) / cases);
  const text = `tras ${streakText}, en el ${where} el precio ${up ? 'subió' : 'bajó'} ${major} de ${cases} veces (${share} %)`;
  const votes = strength(major, cases);
  const vote = votes ? (up ? 1 : -1) * votes : 0;
  return { vote, cases, text: vote ? text : `${text}${cases < MIN_CASES ? ' · pocos casos aún' : ' · sin ventaja clara'}`, data };
}

const slug = (asset) =>
  String(asset || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sin-nombre';

/**
 * Memoria en disco. Un archivo por activo y tamano de vela: memoria/<activo>_<segundos>s.csv
 * con una linea por vela: hora_de_cierre_ms,color(u/d/f),cuerpo,rango,tramos
 * (cuerpo y rango relativos a lo normal; tramos = hacia donde fue el precio en cada tramo, p. ej. "udu").
 */
function createMarketMemory(directory) {
  let asset = 'sin-nombre';
  let records = []; // velas de este activo y tamano de vela (lo guardado + lo de esta sesion)
  let session = []; // velas de esta sesion mientras no se sabe el tamano de vela
  let bucket = 0; // tamano de vela ya identificado (segundos); 0 = todavia no
  let pending = []; // lineas por escribir
  let table = {};
  let moments = {};

  const file = () => path.join(directory, `${asset}_${bucket}s.csv`);
  const rebuild = () => {
    table = streakTable(records);
    moments = momentTable(records);
  };
  const load = () => {
    records = [];
    try {
      const lines = fs.readFileSync(file(), 'utf8').split(/\r?\n/).slice(-MAX_RECORDS);
      for (const line of lines) {
        const [t, d, b, r, s] = line.split(',');
        if (Number(t) > 0 && (d === 'u' || d === 'd' || d === 'f')) {
          records.push({ t: Number(t), d, b: Number(b) || 0, r: Number(r) || 0, s: /^[udf?]+$/.test(s || '') ? s : '' });
        }
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
      moments = {};
    },

    /**
     * Anota una vela que acaba de cerrar.
     * @param {{dir:string, open:number, close:number, high:number, low:number}} candle
     * @param {number} time   Hora de cierre (ms).
     * @param {number} unit   Rango tipico de una vela en este momento (para guardar tamanos relativos).
     * @param {string} [segments]  Hacia donde fue el precio en cada tramo de la vela (ver `segmentsOf`).
     */
    add(candle, time, unit, segments = '') {
      const size = unit > 0 ? unit : 1;
      const record = {
        t: Math.round(time),
        d: letter(candle.dir),
        b: Math.round((10 * Math.abs(candle.close - candle.open)) / size) / 10,
        r: Math.round((10 * (candle.high - candle.low)) / size) / 10,
        s: /^[udf?]+$/.test(segments) ? segments : '',
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

    /**
     * Lo que dice la memoria sobre la situacion actual.
     * @param {Array} candles  Velas cerradas a la vista.
     * @param {object} [clock] Reloj de la vela en curso (ver `momentSituation`). Si viene, se suma
     *        lo que dice la memoria sobre este momento de la vela.
     */
    stats(candles, clock = null) {
      const known = bucket ? records : session;
      const info = situation(bucket ? table : streakTable(session), candles, known.length);
      const moment = bucket && clock ? momentSituation(moments, candles, { ...clock, candleSeconds: bucket }) : null;
      // El voto total no pasa de 2. Si el momento de la vela tiene algo que decir, su texto va primero.
      const vote = Math.max(-2, Math.min(2, info.vote + (moment ? moment.vote : 0)));
      const text = moment && moment.vote ? moment.text : info.text;
      const data = moment ? { ...info.data, por_momento_de_la_vela: moment.data } : info.data;
      return { ...info, vote, text, data, moment, total: known.length, candleSeconds: bucket };
    },

    count: () => (bucket ? records.length : session.length),

    /** Escribe en disco lo pendiente. */
    flush() {
      if (!bucket || pending.length === 0) return;
      const lines = pending.map((r) => `${r.t},${r.d},${r.b},${r.r},${r.s || ''}`).join('\n') + '\n';
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

module.exports = {
  createMarketMemory,
  streakTable,
  momentTable,
  situation,
  momentSituation,
  segmentsOf,
  segmentCount,
  currentStreak,
  periodOf,
  periodBucket,
  slug,
  MIN_CASES,
};
