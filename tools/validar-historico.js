/**
 * Validación histórica del veto anti-rebote y de la estadística por patrón.
 *
 *   node tools/validar-historico.js [carpeta-del-registro]
 *
 * Lee el registro del panel (por defecto %APPDATA%\senales-overlay\registro) SIN modificarlo:
 *   T,ms,precio,pip          precio real leído del eje, unas tres veces por segundo
 *   S,ms,lado,fuente,...     cada señal (lado, quién la dio, confianza, plazo en segundos)
 *   R,ms,resultado           cómo terminó la señal anterior
 * Con los precios "T" rearma las velas de 15 s que había antes de cada señal y le aplica las
 * mismas funciones que usa el panel: patternOf (formations.js) y antiRebound (rebound.js).
 *
 * Límites, dichos de frente:
 *   - Las velas se rearman con el precio leído de la pantalla (no con el dato de la plataforma) y
 *     con el reloj de esta computadora: son una aproximación de las velas reales.
 *   - Solo entran las señales con precio continuo en las 22 velas anteriores.
 *   - El pago real de cada momento no quedó registrado: el P&L se calcula con el pago que se le dé
 *     (92 % por defecto) y es solo una referencia.
 *   - Las señales de esos días salieron de versiones anteriores del panel.
 */
const fs = require('node:fs');
const path = require('node:path');
const { patternOf, PATTERN_KEYS, PATTERNS } = require('../src/formations');
const { antiRebound } = require('../src/rebound');
const { patternStats, breakEvenOf } = require('../src/score');

const CANDLE_MS = 15000;
const NEEDED = Number(process.env.VELAS || 22); // velas cerradas con precio antes de la señal (22 = las 20 de la regla y margen)
const MIN_TICKS = 5; // lecturas de precio por vela para darla por buena
const PAYOUT = Number(process.env.PAGO || 92);

const dir = process.argv[2] || path.join(process.env.APPDATA || '', 'senales-overlay', 'registro');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort() : [];
if (!files.length) {
  console.log(`No hay registro en ${dir}`);
  process.exit(0);
}

const ticks = []; // [ms, precio]
const signals = []; // { ms, dir, source, confidence, seconds, result, file }
for (const file of files) {
  let open = null;
  for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
    const c = line.split(',');
    if (c[0] === 'T') {
      const ms = Number(c[1]);
      const price = Number(c[2]);
      if (Number.isFinite(ms) && Number.isFinite(price)) ticks.push([ms, price]);
    } else if (c[0] === 'S') {
      open = { ms: Number(c[1]), dir: c[2], source: c[3], confidence: c[4], seconds: Number(c[5]), file };
    } else if (c[0] === 'R' && open) {
      const text = c[2] || '';
      open.result = /^acert/.test(text) ? 'win' : /^fall/.test(text) ? 'loss' : /^empate/.test(text) ? 'tie' : null;
      signals.push(open);
      open = null;
    }
  }
}
ticks.sort((a, b) => a[0] - b[0]);

// Velas de 15 s por "cubeta" de reloj.
const buckets = new Map();
for (const [ms, price] of ticks) {
  const key = Math.floor(ms / CANDLE_MS);
  const b = buckets.get(key);
  if (!b) buckets.set(key, { open: price, high: price, low: price, close: price, n: 1, ticks: [[ms, price]] });
  else {
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.close = price;
    b.n++;
    b.ticks.push([ms, price]);
  }
}
const asCandle = (b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, dir: b.close > b.open ? 'up' : b.close < b.open ? 'down' : 'flat' });

/** Velas (cerradas + la que estaba en curso hasta ese instante) justo antes de una señal; null si falta precio. */
function candlesBefore(ms) {
  const key = Math.floor(ms / CANDLE_MS);
  const out = [];
  for (let i = key - NEEDED; i < key; i++) {
    const b = buckets.get(i);
    if (!b || b.n < MIN_TICKS) return null;
    out.push(asCandle(b));
  }
  const current = buckets.get(key);
  const seen = current ? current.ticks.filter((t) => t[0] <= ms) : [];
  if (!seen.length) return null;
  const forming = { open: seen[0][1], high: Math.max(...seen.map((t) => t[1])), low: Math.min(...seen.map((t) => t[1])), close: seen[seen.length - 1][1] };
  out.push({ ...forming, dir: forming.close > forming.open ? 'up' : forming.close < forming.open ? 'down' : 'flat' });
  return out;
}

const sided = signals.filter((s) => (s.dir === 'up' || s.dir === 'down') && s.result);
const short = sided.filter((s) => s.seconds > 0 && s.seconds < 60);
const rows = [];
for (const s of short) {
  const candles = candlesBefore(s.ms);
  if (!candles) continue;
  const pattern = patternOf({ candles, dir: s.dir });
  const check = antiRebound({ candles, dir: s.dir });
  rows.push({ ...s, pattern: pattern.key, veto: check.veto, data: check.data, allowed: check.allowed });
}

const pct = (wins, losses) => (wins + losses ? `${((100 * wins) / (wins + losses)).toFixed(1)} %` : '—');
const count = (list) => ({
  n: list.length,
  wins: list.filter((r) => r.result === 'win').length,
  losses: list.filter((r) => r.result === 'loss').length,
  ties: list.filter((r) => r.result === 'tie').length,
});
const pnl = (c) => (c.wins * PAYOUT) / 100 - c.losses;
const line = (label, c) => `${label.padEnd(28)} ${String(c.n).padStart(4)}  ${String(c.wins).padStart(3)} G  ${String(c.losses).padStart(3)} P  ${String(c.ties).padStart(2)} E   acierto ${pct(c.wins, c.losses).padStart(7)}   P&L ${pnl(c).toFixed(2).padStart(7)}`;

console.log(`Registro: ${dir}`);
console.log(`Días: ${files[0].slice(0, 10)} a ${files[files.length - 1].slice(0, 10)} · ${ticks.length} lecturas de precio`);
console.log(`Señales con lado y resultado: ${sided.length} · de plazo corto (< 60 s): ${short.length} · con velas completas antes: ${rows.length}`);
console.log(`Pago usado para el P&L: ${PAYOUT} % (punto de equilibrio ${(100 * breakEvenOf(PAYOUT)).toFixed(1)} %). El pago real de esos momentos no quedó registrado.`);
console.log('');
console.log(line('TODAS (con velas completas)', count(rows)));
console.log('');
console.log('--- Por patrón ---');
for (const key of PATTERN_KEYS) {
  const list = rows.filter((r) => r.pattern === key);
  if (list.length) console.log(line(PATTERNS[key], count(list)));
}
console.log('');
console.log('--- Veto anti-rebote ---');
const blocked = rows.filter((r) => r.veto);
const passed = rows.filter((r) => !r.veto);
console.log(line('Habría BLOQUEADO', count(blocked)));
console.log(line('Habría dejado pasar', count(passed)));
for (const r of blocked) {
  const when = new Date(r.ms).toLocaleString('es-MX', { hour12: false });
  console.log(`   ${when}  ${r.dir === 'up' ? 'ARRIBA' : 'ABAJO '}  ${r.result === 'win' ? 'ganó ' : r.result === 'loss' ? 'perdió' : 'empate'}  velas ${r.data.velas}, cuerpos ${r.data.cuerpos.join('/')}x, ${r.data.despues} velas después, retroceso ${r.data.retroceso} %`);
}
console.log('');
console.log('--- Auto-veto por patrón, aplicado en orden sobre estas señales ---');
{
  // Se recorre el historial en orden: cada señal se veta si, con lo visto hasta ese momento, su
  // patrón tenía 20+ decididas y acierto bajo el punto de equilibrio. Las vetadas siguen contando
  // en la estadística (medidas en papel), igual que en el panel.
  const seen = [];
  const vetoed = [];
  const shown = [];
  for (const r of rows) {
    const stats = patternStats(seen)[r.pattern];
    (stats && stats.vetoed ? vetoed : shown).push(r);
    seen.push({ pattern: r.pattern, result: r.result, payout: PAYOUT });
  }
  console.log(line('Habría VETADO', count(vetoed)));
  console.log(line('Habría mostrado', count(shown)));
  const final = patternStats(seen);
  const off = Object.values(final).filter((p) => p.vetoed).map((p) => `${PATTERNS[p.pattern]} (${p.accuracy} % en ${p.decided})`);
  console.log(`Patrones que terminarían desactivados: ${off.length ? off.join('; ') : 'ninguno'}`);
}
console.log('');
console.log('--- Los dos vetos juntos (anti-rebote primero) ---');
{
  const seen = [];
  const out = [];
  const shown = [];
  for (const r of rows) {
    const stats = patternStats(seen)[r.pattern];
    if (r.veto) out.push(r);
    else {
      (stats && stats.vetoed ? out : shown).push(r);
      seen.push({ pattern: r.pattern, result: r.result, payout: PAYOUT });
    }
  }
  console.log(line('Bloqueadas en total', count(out)));
  console.log(line('Mostradas', count(shown)));
}
