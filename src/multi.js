/**
 * VARIOS PARES A LA VEZ (16 nov 2026).
 *
 * Orden del usuario: «se puede poner hasta cuatro… que escanee las 4 y puedes estar pendiente al mismo tiempo e ir
 * brincando… así puedes buscar la recuperación en más de alguna». El panel lee UNA gráfica de la pantalla; para
 * analizar varias a la vez le pide al bot las velas de 15 s de esos pares (el bot ya recibe el precio de todos)
 * y les pasa las mismas lecturas y el mismo tipo de jugada que a la gráfica de la pantalla.
 *
 * En cada vuelta: se lee cada par, se escoge el que tiene más lecturas de acuerdo y ahí entra el bot (DEMO).
 * Si pierde, la martingala se busca otra vez entre TODOS los pares: sale en el que tenga la mejor lectura en ese
 * momento, sea el mismo u otro. Un empate repite el monto (no corta la serie).
 *
 * Medido ese dia con estas mismas reglas sobre 59 pares grabados (115,766 casos): 49.9 % y 50.0 % en las dos
 * mitades; escoger par no sube el acierto, da mas entradas y deja buscar la recuperacion en otro par.
 *
 * Registro: Q,ms,lectura,PAR:lado:ventaja:tipo;…  ·  Q,ms,entrada,par,lado,nivel,tipo,arriba,abajo
 *           Q,ms,abierta,id,precio,pago,monto,ms  ·  Q,ms,resultado,win|loss|tie,neto,cierre,par,nivel
 *           Q,ms,fallo,motivo  ·  Q,ms,serie,ganada|perdida,neto
 */
const { computeReadings } = require('./readings');
const { patternOf } = require('./formations');

const MIN_CANDLES = 40; // con menos velas faltan MACD, volatilidad y temporalidad mayor
const STALE_S = 3; // un par sin precio nuevo en 3 s no se toca
const toCandle = (c) => ({ open: c[0], high: c[1], low: c[2], close: c[3] });

/**
 * Lo que dice el panel de un par.
 * @param {{closed:number[][], forming:number[], time:Date, asset:string}} input velas [o,h,l,c] cerradas y la que va en curso
 * @returns {{dir:'up'|'down'|null, margin:number, ups:number, downs:number, pattern:string}|null}
 */
function readPair({ closed, forming, time, asset = '' }) {
  if (!Array.isArray(closed) || closed.length < MIN_CANDLES || !Array.isArray(forming)) return null;
  const candles = closed.map(toCandle);
  const current = toCandle(forming);
  let readings;
  try {
    readings = computeReadings({ candles, forming: current, time, asset });
  } catch {
    return null;
  }
  if (!readings) return null;
  const votes = readings.items.filter((item) => item.key !== 'summary' && item.vote).map((item) => Math.sign(item.vote));
  const ups = votes.filter((v) => v > 0).length;
  const downs = votes.length - ups;
  const dir = ups > downs ? 'up' : downs > ups ? 'down' : null;
  const pattern = dir ? patternOf({ candles: [...candles, current], dir }).key : 'otro';
  return { dir, margin: Math.abs(ups - downs), ups, downs, pattern };
}

/**
 * El par donde conviene entrar ahora: el de mayor ventaja en votos; si empatan, el que paga mas y despues el de
 * precio mas fresco. `avoid` = tipos de jugada apagados.
 */
function pickBest(reads, { minMargin = 2, minPayout = 80, avoid = [] } = {}) {
  const ok = reads.filter((r) => r.read && r.read.dir && r.read.margin >= minMargin && r.age <= STALE_S && (r.payout || 0) >= minPayout && !avoid.includes(r.read.pattern));
  ok.sort((a, b) => b.read.margin - a.read.margin || (b.payout || 0) - (a.payout || 0) || a.age - b.age);
  return ok[0] || null;
}

/**
 * El motor: una operacion a la vez, la serie (senal + martingalas) se lleva entre todos los pares.
 * @param {{bot:object, record:Function, settings:Function, now?:Function}} deps
 *   settings() → { on, pairs:string[], seconds, levels, minMargin, minPayout, avoid:string[], restMs }
 */
function createMultiEngine({ bot, record, settings, now = Date.now }) {
  const plain = (text) => String(text || '').replace(/[,\r\n]+/g, ' ').slice(0, 160);
  const state = {
    busy: false, // preguntando al bot o con una operacion abierta
    level: 0,
    seriesNet: 0,
    reads: [],
    pick: null,
    order: null, // { name, dir, level, state:'sending'|'open', amount, payout }
    last: null, // ultima operacion cerrada: { name, dir, level, result, net }
    note: '',
    tally: { wins: 0, losses: 0, ties: 0, net: 0, series: 0, lost: 0 },
    loggedAt: 0,
    restUntil: 0, // despues de cerrar una serie se analiza unos segundos antes de abrir otra
  };

  async function tick() {
    const cfg = settings();
    if (!cfg.on) {
      state.note = '';
      state.reads = [];
      return;
    }
    if (state.busy) return;
    state.busy = true;
    try {
      const answer = await bot.candles(cfg.pairs);
      if (!answer || !answer.ok) throw new Error((answer && answer.error) || 'el bot no dio las velas');
      const time = new Date(now());
      state.reads = answer.pairs.map(([symbol, name, payout, closed, forming, age]) => ({ symbol, name, payout, age, candles: closed.length, read: readPair({ closed, forming, time, asset: name }) }));
      const best = pickBest(state.reads, cfg);
      state.pick = best ? best.name : null;
      if (now() - state.loggedAt >= 5000 || best) {
        state.loggedAt = now();
        record(`Q,${now()},lectura,${state.reads.map((r) => `${r.name}:${r.read && r.read.dir ? r.read.dir : '-'}:${r.read ? r.read.margin : 0}:${r.read ? r.read.pattern : 'faltan-velas'}`).join(';')}`);
      }
      if (!best) {
        const missing = state.reads.filter((r) => !r.read).length;
        state.note = !state.reads.length ? 'el bot no tiene precio de esos pares' : missing === state.reads.length ? 'juntando velas de los pares' : 'ningún par con lectura clara';
        return;
      }
      if (state.level === 0 && now() < state.restUntil) {
        state.note = 'analizando antes de la siguiente entrada';
        return;
      }
      state.note = '';
      await play(best, cfg);
    } catch (err) {
      state.note = err.message;
    } finally {
      state.busy = false;
    }
  }

  async function play(best, cfg) {
    const level = state.level;
    const order = { name: best.name, dir: best.read.dir, level, state: 'sending', pattern: best.read.pattern };
    state.order = order;
    record(`Q,${now()},entrada,${plain(best.name)},${order.dir},${level},${best.read.pattern},${best.read.ups},${best.read.downs}`);
    let done;
    try {
      const opened = await bot.order({ asset: best.name, dir: order.dir, seconds: cfg.seconds, level });
      if (!opened || !opened.ok) throw new Error((opened && opened.error) || 'sin respuesta del bot');
      order.state = 'open';
      order.amount = opened.amount;
      order.payout = opened.payout;
      record(`Q,${now()},abierta,${opened.id},${opened.open_price},${opened.payout},${opened.amount},${opened.open_ms - opened.sent_ms}`);
      done = await bot.result(opened.id, cfg.seconds);
      if (!done || !done.ok) throw new Error((done && done.error) || 'sin resultado del bot');
    } catch (err) {
      record(`Q,${now()},fallo,${plain(err.message)}`);
      state.order = null;
      state.note = err.message;
      return;
    }
    const net = Number(done.net) || 0;
    record(`Q,${now()},resultado,${done.result},${net},${done.close_price},${plain(best.name)},${level}`);
    state.order = null;
    state.last = { name: best.name, dir: order.dir, level, result: done.result, net };
    state.tally.net += net;
    state.seriesNet += net;
    const endSeries = (how) => {
      record(`Q,${now()},serie,${how},${state.seriesNet.toFixed(2)}`);
      state.tally.series++;
      if (how === 'perdida') state.tally.lost++;
      state.level = 0;
      state.seriesNet = 0;
      state.restUntil = now() + (cfg.restMs || 0);
    };
    if (done.result === 'win') {
      state.tally.wins++;
      endSeries('ganada');
    } else if (done.result === 'loss') {
      state.tally.losses++;
      if (level >= cfg.levels) endSeries('perdida');
      else state.level = level + 1; // la recuperacion se busca en la vuelta siguiente, en el par que mejor lectura tenga
    } else {
      state.tally.ties++; // empate: se repite el mismo monto
    }
  }

  return {
    tick,
    /** Para pintar en el panel. */
    view() {
      const cfg = settings();
      return {
        on: Boolean(cfg.on),
        pairs: state.reads.map((r) => ({ name: r.name, payout: r.payout, dir: r.read ? r.read.dir : null, margin: r.read ? r.read.margin : 0, pattern: r.read ? r.read.pattern : null, ready: Boolean(r.read), stale: r.age > STALE_S })),
        pick: state.pick,
        level: state.level,
        order: state.order ? { name: state.order.name, dir: state.order.dir, level: state.order.level, state: state.order.state, amount: state.order.amount || null } : null,
        last: state.last,
        note: state.note,
        tally: { ...state.tally },
      };
    },
  };
}

module.exports = { readPair, pickBest, createMultiEngine, MIN_CANDLES };
