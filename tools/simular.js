/**
 * Simulacion de las reglas del panel.
 *
 * Uso:
 *   node tools/simular.js                 mercados artificiales (azar, tendencia, rebote)
 *   node tools/simular.js archivo.csv     precio real grabado por el panel (carpeta "registro")
 *   opciones: --segundos 5   --horas 6
 *
 * Que hace: recorre el precio lectura a lectura (cada 300 ms, como el panel), arma las
 * velas, y cada pocos segundos pregunta a las MISMAS funciones que usa el panel hacia donde
 * iria el precio. Luego mira que paso de verdad pasados N segundos y cuenta aciertos:
 * de la senal completa, por nivel de confianza y de cada lectura por separado.
 *
 * Para que sirve y para que no:
 *   - Sirve para encontrar fallas (una lectura que resta en vez de sumar, umbrales que
 *     dependen del zoom, confianza "alta" que no acierta mas que la "baja").
 *   - En el mercado al azar TODO debe dar ~50 %: es la prueba de que no hay trampa.
 *   - Los mercados artificiales NO son el mercado real. Para afinar de verdad hace falta
 *     el precio grabado de la grafica (segunda forma de uso).
 */
const fs = require('node:fs');
const { decide, tickMomentum } = require('../src/timed');
const { trendSignal, candlePattern } = require('../src/signal');
const { computeReadings } = require('../src/readings');
const { measureRegime } = require('../src/regime');

const TICK_MS = 300;
const CANDLE_TICKS = 50; // velas de 15 s
const VISIBLE = 30; // velas a la vista
const HISTORY = 400;
const REGIME_TICKS = 6000; // 30 minutos de precio para medir el patron

// ---------- Azar reproducible ----------
function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform()); // normal(0,1)
}

/** Precio artificial, en pixeles (mayor = mas alto). sigma = movimiento tipico por lectura. */
function synthetic(kind, ticks, sigma, seed) {
  const z = rng(seed);
  const out = new Float64Array(ticks);
  let p = 0;
  let drift = 0; // tendencia que cambia despacio
  let mean = 0; // nivel al que el precio tiende a volver
  for (let i = 0; i < ticks; i++) {
    if (kind === 'azar') p += sigma * z();
    else if (kind === 'tendencia') {
      drift = 0.995 * drift + 0.03 * sigma * z(); // rachas de ~1 minuto
      p += drift + sigma * z();
    } else if (kind === 'rebote') {
      mean += 0.1 * sigma * z();
      p += -0.04 * (p - mean) + sigma * z(); // lo que se aleja, vuelve (vida media ~5 s)
    }
    out[i] = p;
  }
  return out;
}

/** Precio grabado por el panel: CSV con columnas tiempo_ms,precio (se pasa a "pixeles" por pip). */
function recorded(file) {
  const rows = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((cols) => cols[0] === 'T' && cols.length >= 3 && Number.isFinite(Number(cols[2])) && cols[2] !== '');
  if (rows.length < 500) throw new Error(`El registro tiene solo ${rows.length} lecturas de precio; hacen falta al menos 500 (unos 3 minutos).`);
  // Se remuestrea a una lectura cada 300 ms (la ultima conocida).
  const t0 = Number(rows[0][1]);
  const tEnd = Number(rows[rows.length - 1][1]);
  const perPip = Number(rows[0][3]) || 0.0001;
  const out = [];
  let j = 0;
  for (let t = t0; t <= tEnd; t += TICK_MS) {
    while (j + 1 < rows.length && Number(rows[j + 1][1]) <= t) j++;
    out.push((Number(rows[j][2]) / perPip) * 2); // 2 px por pip: escala parecida a la de la pantalla
  }
  return Float64Array.from(out);
}

const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const dirOf = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : null);

/** Recorre un precio y devuelve los aciertos de la senal y de cada lectura. */
function run(price, horizonTicks, options = {}) {
  const stats = {};
  const add = (name, vote, outcome) => {
    if (!vote || !outcome) return;
    const s = (stats[name] = stats[name] || { n: 0, hits: 0 });
    s.n++;
    if (sign(vote) === outcome) s.hits++;
  };
  const px = (i) => Math.round(price[i]); // la pantalla solo tiene pixeles enteros
  const track = Array.from(price, (v, k) => ({ time: k * TICK_MS, value: Math.round(v) }));
  const completed = [];
  const stepEvery = options.stepTicks || horizonTicks;
  let x = 0;
  for (let start = 0; start + CANDLE_TICKS <= price.length; start += CANDLE_TICKS) {
    let high = -Infinity;
    let low = Infinity;
    for (let i = start; i < start + CANDLE_TICKS; i++) {
      high = Math.max(high, px(i));
      low = Math.min(low, px(i));
    }
    const open = px(start);
    const close = px(start + CANDLE_TICKS - 1);
    completed.push({ x0: x, x1: x + 6, dir: dirOf(close - open) || 'flat', open, close, high, low, end: start + CANDLE_TICKS });
    x += 9;
  }

  for (let i = (VISIBLE + 2) * CANDLE_TICKS; i + horizonTicks < price.length; i += stepEvery) {
    const closedCount = Math.floor(i / CANDLE_TICKS);
    const past = completed.slice(Math.max(0, closedCount - HISTORY), closedCount);
    // Vela en curso: desde su apertura hasta esta lectura.
    const start = closedCount * CANDLE_TICKS;
    let high = -Infinity;
    let low = Infinity;
    for (let k = start; k <= i; k++) {
      high = Math.max(high, px(k));
      low = Math.min(low, px(k));
    }
    const forming = { dir: dirOf(px(i) - px(start)) || 'flat', open: px(start), close: px(i), high, low };
    const visible = [...past.slice(-VISIBLE), forming];
    const now = i * TICK_MS;

    // Lecturas del precio de los ultimos 6 s (fila = -precio).
    const ticks = [];
    for (let k = Math.max(0, i - 20); k <= i; k++) ticks.push({ time: k * TICK_MS, y: -px(k) });
    const live = tickMomentum(ticks, now);
    // Movimiento por tramos: los ultimos 4 tramos del tamano del horizonte.
    const moves = [];
    for (let m = 4; m >= 1; m--) {
      const a = i - m * horizonTicks;
      if (a >= 0) moves.push(dirOf(px(a + horizonTicks) - px(a)) || 'flat');
    }
    const trend = trendSignal(visible);
    const pattern = candlePattern(forming, visible[visible.length - 2], visible.slice(0, -1));
    const prices = [];
    for (let k = Math.max(0, i - 200); k <= i; k += 2) prices.push({ time: k * TICK_MS, value: px(k) });
    const readings = computeReadings({ candles: past, forming, prices, now: live, time: now });
    const context = readings ? { vote: readings.vote, follow: readings.follow, reverse: readings.reverse, text: readings.text } : null;
    // Patron medido con los ultimos 30 minutos de precio (como hace el panel).
    let regime = null;
    if (options.regime !== false) {
      const from = Math.max(0, i - REGIME_TICKS);
      regime = measureRegime(track.slice(from, i + 1), horizonTicks * TICK_MS, now);
    }
    const decision = decide(trend, pattern, moves, { force: true, ticks: live, context, regime, fallback: forming.dir === 'flat' ? null : forming.dir });
    if (regime) add('  patrón: ' + (regime.kind || 'sin patrón claro'), decision.dir === 'up' ? 1 : -1, sign(px(i + horizonTicks) - px(i)));

    const outcome = sign(px(i + horizonTicks) - px(i));
    add('SEÑAL (todas)', decision.dir === 'up' ? 1 : -1, outcome);
    add(`  confianza ${decision.confidence}`, decision.dir === 'up' ? 1 : -1, outcome);
    add('precio ahora (ticks)', live.vote, outcome);
    if (live.turn) add('  · giro desde pico/piso', live.vote, outcome);
    add('vela actual (patrón)', pattern.vote, outcome);
    if (pattern.blocks) add('  · vela estirada → regreso', pattern.blocks === 'up' ? -1 : 1, outcome);
    add('precio por tramos', moves.length ? sign({ up: 1, down: -1 }[moves[moves.length - 1]] || 0) : 0, outcome);
    add('velas (últimas 4)', { up: 1, down: -1 }[trend.dir] || 0, outcome);
    add('8 lecturas (resumen)', context ? context.vote : 0, outcome);
    if (readings) for (const item of readings.items) if (item.vote && item.key !== 'summary') add(`  · ${item.key}`, item.vote, outcome);
  }
  return stats;
}

function merge(total, part) {
  for (const [name, s] of Object.entries(part)) {
    const t = (total[name] = total[name] || { n: 0, hits: 0 });
    t.n += s.n;
    t.hits += s.hits;
  }
  return total;
}

function print(title, stats) {
  console.log(`\n=== ${title} ===`);
  for (const [name, s] of Object.entries(stats)) {
    const rate = (100 * s.hits) / s.n;
    const margin = 196 * Math.sqrt(0.25 / s.n); // +-, 95 %
    console.log(`${name.padEnd(30)} ${rate.toFixed(1).padStart(5)} %  ±${margin.toFixed(1).padStart(4)}  (${s.n} casos)`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? Number(args[at + 1]) : fallback;
  };
  const seconds = option('segundos', 5);
  const hours = option('horas', 6);
  const horizonTicks = Math.round((seconds * 1000) / TICK_MS);
  const file = args.find((a) => !a.startsWith('--') && !/^\d+(\.\d+)?$/.test(a));

  if (file) {
    const price = recorded(file);
    print(`PRECIO REAL GRABADO · ${file} · ${(price.length * TICK_MS / 60000).toFixed(1)} min · señal a ${seconds} s`, run(price, horizonTicks, { stepTicks: 3 }));
    console.log('\nOjo: con menos de ~300 casos el margen (±) es mayor que cualquier diferencia que se quiera medir.');
    return;
  }
  const ticks = Math.round((hours * 3600 * 1000) / TICK_MS);
  const detail = args.includes('--detalle');
  const pct = (s) => (s ? `${((100 * s.hits) / s.n).toFixed(1)} %` : '   -  ').padStart(7);
  console.log(`Señal a ${seconds} s · ${hours} h de precio por mercado · 3 repeticiones. Margen de cada cifra: ±1 a ±2 puntos.`);
  console.log('mercado     px/lectura | SEÑAL sin patrón → con patrón | alta: sin → con | media: sin → con | baja: sin → con');
  for (const kind of ['azar', 'tendencia', 'rebote']) {
    for (const sigma of [0.4, 1.2, 3.5]) {
      let before = {};
      let after = {};
      for (let seed = 1; seed <= 3; seed++) {
        const price = synthetic(kind, ticks, sigma, seed * 7919 + Math.round(sigma * 10));
        before = merge(before, run(price, horizonTicks, { regime: false }));
        after = merge(after, run(price, horizonTicks));
      }
      const row = (name) => `${pct(before[name])} → ${pct(after[name])}`;
      console.log(
        `${kind.padEnd(11)} ${String(sigma).padStart(6)}     |      ${row('SEÑAL (todas)')}      | ${row('  confianza alta')} | ${row('  confianza media')} | ${row('  confianza baja')}`,
      );
      if (detail) print(`${kind.toUpperCase()} · ${sigma} px · con patrón medido`, after);
    }
  }
}

if (require.main === module) main();
module.exports = { run, synthetic, recorded, rng };
