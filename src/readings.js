/**
 * Las 8 lecturas del panel, calculadas con las velas leidas de la pantalla:
 *
 *   1. Tendencia       hacia donde van las ultimas velas (hasta 12).
 *   2. EMA 50/200      media rapida contra media lenta. Se usan 50/200 cuando hay 200
 *                      velas acumuladas; antes, el par mas largo que alcance (se indica cual).
 *   3. Momentum        cuanto avanzo el precio en las ultimas 5 velas, y como va ahora mismo.
 *   4. RSI 14          fuerza relativa; 70 o mas = sobrecompra, 30 o menos = sobreventa.
 *   5. Mov. 1 min      cuanto se movio el precio en el ultimo minuto.
 *   6. Nivel abajo     soporte mas cercano por debajo del precio (y resistencia por encima).
 *   7. Sesion          sesion de mercado segun la hora. No vota (y en OTC no aplica).
 *   8. Resumen         cuantas lecturas apuntan hacia arriba y cuantas hacia abajo.
 *
 * No hay precios reales (solo pixeles de la pantalla), asi que las distancias se
 * dan en "velas": 1 vela = el tamano tipico de una vela de esta grafica.
 *
 * Todo es simetrico: la misma grafica volteada da las lecturas contrarias.
 * Esto DESCRIBE la grafica; no garantiza hacia donde ira el precio.
 */
const { slope, rsi } = require('./signal');

const TREND_CANDLES = 12; // pocas velas: el foco es lo reciente y la vela en curso
const LEVEL_CANDLES = 30; // velas en las que se buscan soportes y resistencias
const RSI_PERIOD = 14;
const MOMENTUM_CANDLES = 5;
const MINUTE_MS = 60 * 1000;
const EMA_PAIRS = [
  [50, 200],
  [25, 100],
  [12, 50],
  [9, 21],
  [5, 10],
];
const SPARK_POINTS = 30;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] || 0;
};
const leanOf = (vote) => (vote > 0 ? 'up' : vote < 0 ? 'down' : 'flat');
const arrow = { up: 'arriba ↑', down: 'abajo ↓', flat: 'lateral' };
const round1 = (v) => Math.round(v * 10) / 10;

/** Reduce una serie a como mucho SPARK_POINTS puntos, para la mini-grafica. */
function spark(values) {
  if (values.length <= SPARK_POINTS) return values.map(round1);
  const out = [];
  for (let i = 0; i < SPARK_POINTS; i++) out.push(round1(values[Math.round((i * (values.length - 1)) / (SPARK_POINTS - 1))]));
  return out;
}

/** Serie completa de una media movil exponencial. */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Agrupa valores cercanos (a menos de `gap`) en niveles: [{ value, touches }]. */
function cluster(values, gap) {
  const sorted = [...values].sort((a, b) => a - b);
  const levels = [];
  for (const v of sorted) {
    const last = levels[levels.length - 1];
    if (last && v - last.max <= gap) {
      last.sum += v;
      last.touches++;
      last.max = v;
    } else levels.push({ sum: v, touches: 1, max: v });
  }
  return levels.map((l) => ({ value: l.sum / l.touches, touches: l.touches }));
}

/** Soportes (minimos locales) y resistencias (maximos locales) de las velas cerradas. */
function findLevels(candles, unit, forming = null) {
  const lows = [];
  const highs = [];
  // La vela en curso cuenta como vecina: asi el pico (o el piso) mas reciente tambien sale como
  // nivel en cuanto hay una vela cerrada despues de el y la vela en curso tampoco lo supera.
  // Es justo el nivel que mas importa: el ultimo sitio donde el precio se dio la vuelta.
  const list = forming ? [...candles, forming] : candles;
  for (let i = 2; i < list.length - 2; i++) {
    const around = [list[i - 2], list[i - 1], list[i + 1], list[i + 2]];
    if (around.every((c) => list[i].low <= c.low)) lows.push(list[i].low);
    if (around.every((c) => list[i].high >= c.high)) highs.push(list[i].high);
  }
  return { supports: cluster(lows, unit * 0.35), resistances: cluster(highs, unit * 0.35) };
}

/** Sesion de mercado segun la hora UTC. */
function sessionAt(now, asset = '') {
  if (/otc/i.test(asset)) return { text: 'OTC · 24 h', detail: 'Par OTC: cotización propia del bróker, no sigue las sesiones del mercado.' };
  const hour = new Date(now).getUTCHours();
  let text = 'Fuera de hora';
  if (hour < 7) text = 'Asia';
  else if (hour < 12) text = 'Londres';
  else if (hour < 16) text = 'Londres + NY';
  else if (hour < 21) text = 'Nueva York';
  return { text, detail: `Sesión de mercado por la hora (${String(hour).padStart(2, '0')}:00 UTC). No cuenta como voto.` };
}

/**
 * @param {object} input
 * @param {Array} input.candles   Velas cerradas (historial largo), la mas reciente al final.
 * @param {object} input.forming  Vela en curso.
 * @param {Array<{time:number,value:number}>} [input.prices]  Recorrido del precio (mayor = mas alto).
 * @param {{vote:number,text:string}} [input.now]  Movimiento del precio ahora mismo (lectura a lectura).
 * @param {number} input.time     Reloj en milisegundos.
 * @param {string} [input.asset]
 * @returns {{ items: Array, vote: number, text: string, data: object } | null}
 */
function computeReadings({ candles, forming, prices = [], now = null, time, asset = '', pips = null, trendCandles = TREND_CANDLES }) {
  if (!forming || candles.length < 4) return null;
  const all = [...candles, forming];
  const closes = all.map((c) => c.close);
  const price = forming.close;
  const unit = median(all.slice(-20).map((c) => c.high - c.low)) || 1;
  const inUnits = (v) => round1(v / unit);
  // Si se pudo leer el eje de precios, las distancias se dan en pips; si no, en "velas".
  const inPips = (px) => {
    const value = (Math.abs(px) * pips.perPixel) / pips.pip;
    return value >= 10 ? Math.round(value) : round1(value);
  };
  const distance = (px) => (pips ? `${inPips(px)} pips` : `${Math.abs(inUnits(px))} velas`);
  const count = all.length;

  // 1) Tendencia
  const trendCount = Math.min(trendCandles, count);
  const trendCloses = closes.slice(-trendCount);
  const drift = slope(trendCloses) * (trendCount - 1);
  const trendVote = Math.abs(drift) < unit ? 0 : Math.sign(drift);
  const trend = {
    key: 'trend',
    name: `Tendencia · ${trendCount} velas`,
    text: arrow[leanOf(trendVote)],
    lean: leanOf(trendVote),
    vote: trendVote,
    spark: spark(trendCloses),
    detail: `Las últimas ${trendCount} velas ${trendVote ? `avanzaron ${Math.abs(inUnits(drift))} velas hacia ${trendVote > 0 ? 'arriba' : 'abajo'}` : 'van de lado'}.`,
  };

  // 2) EMA rapida / lenta
  const pair = EMA_PAIRS.find(([, slow]) => count >= slow);
  let ema;
  if (!pair) {
    ema = { key: 'ema', name: 'EMA 50/200', text: 'faltan velas', lean: 'flat', vote: 0, detail: `Hay ${count} velas; se necesitan al menos 10.` };
  } else {
    const [fastN, slowN] = pair;
    const fast = emaSeries(closes, fastN);
    const slow = emaSeries(closes, slowN);
    const gaps = fast.map((v, i) => v - slow[i]);
    const gap = gaps[gaps.length - 1];
    const emaVote = Math.abs(gap) < unit * 0.05 ? 0 : Math.sign(gap);
    const real = slowN === 200;
    ema = {
      key: 'ema',
      name: `EMA ${fastN}/${slowN}`,
      text: arrow[leanOf(emaVote)],
      lean: leanOf(emaVote),
      vote: emaVote,
      spark: spark(gaps.slice(-TREND_CANDLES)),
      periods: [fastN, slowN],
      detail: real
        ? 'Media de 50 velas contra media de 200.'
        : `Con ${count} velas guardadas se usa ${fastN}/${slowN}. Pasa a 50/200 al juntar 200 (deja el panel abierto).`,
    };
  }

  // 3) Momentum
  const back = Math.min(MOMENTUM_CANDLES, count - 1);
  const roc = closes[count - 1] - closes[count - 1 - back];
  const rocVote = Math.abs(roc) < unit * 0.3 ? 0 : Math.sign(roc);
  const live = now && (now.vote || now.fading) ? now : null;
  const momentum = {
    key: 'momentum',
    name: 'Momentum',
    text: live ? live.text : arrow[leanOf(rocVote)],
    lean: live ? leanOf(live.vote) : leanOf(rocVote),
    vote: rocVote,
    spark: spark(closes.slice(-12)),
    detail: `En ${back} velas el precio ${rocVote ? `${rocVote > 0 ? 'subió' : 'bajó'} ${Math.abs(inUnits(roc))} velas` : 'casi no avanzó'}${live ? `; ahora mismo va ${live.text}` : ''}.`,
  };

  // 4) RSI
  const rsiAt = (end) => rsi(closes.slice(0, end), RSI_PERIOD);
  const strength = Math.round(rsiAt(count));
  const rsiVote = strength >= 70 ? -1 : strength <= 30 ? 1 : 0; // extremos: se espera regreso
  const rsiSeries = [];
  for (let end = Math.max(3, count - SPARK_POINTS + 1); end <= count; end++) rsiSeries.push(rsiAt(end));
  const rsiReading = {
    key: 'rsi',
    name: `RSI ${RSI_PERIOD}`,
    text: String(strength) + (strength >= 70 ? ' sobrecompra' : strength <= 30 ? ' sobreventa' : ''),
    lean: leanOf(rsiVote),
    vote: rsiVote,
    value: strength,
    spark: spark(rsiSeries),
    detail: strength >= 70 ? 'Sobrecompra: suele venir un regreso hacia abajo.' : strength <= 30 ? 'Sobreventa: suele venir un rebote hacia arriba.' : 'Zona media: no dice nada.',
  };

  // 5) Movimiento en 1 minuto
  const minute = prices.filter((p) => time - p.time <= MINUTE_MS);
  let move;
  if (minute.length < 4 || minute[minute.length - 1].time - minute[0].time < 4000) {
    move = { key: 'move', name: 'Mov. 1 min', text: 'midiendo…', lean: 'flat', vote: 0, detail: 'Necesita unos segundos de lecturas del precio.' };
  } else {
    const values = minute.map((p) => p.value);
    const swing = (Math.max(...values) - Math.min(...values)) / 2;
    const net = values[values.length - 1] - values[0];
    const seconds = Math.round((minute[minute.length - 1].time - minute[0].time) / 1000);
    const netVote = Math.abs(net) < unit * 0.3 ? 0 : Math.sign(net);
    move = {
      key: 'move',
      name: seconds >= 55 ? 'Mov. 1 min' : `Mov. ${seconds} s`,
      text: `±${distance(swing)}`,
      lean: leanOf(netVote),
      vote: 0, // mide cuanto se mueve, no hacia donde
      swing: inUnits(swing),
      net: inUnits(net),
      swingPips: pips ? inPips(swing) : null,
      netPips: pips ? inPips(net) * Math.sign(net) : null,
      spark: spark(values),
      detail: `En ${seconds} s el precio osciló ±${distance(swing)} y quedó ${netVote ? `${distance(net)} ${netVote > 0 ? 'arriba' : 'abajo'}` : 'casi igual'}. No cuenta como voto.`,
    };
  }

  // 6) Nivel abajo (soporte) y arriba (resistencia)
  const { supports, resistances } = findLevels(candles.slice(-LEVEL_CANDLES), unit, forming);
  const below = supports.filter((l) => l.value < price - unit * 0.05).pop() || null;
  const above = resistances.find((l) => l.value > price + unit * 0.05) || null;
  const toSupport = below ? (price - below.value) / unit : Infinity;
  const toResistance = above ? (above.value - price) / unit : Infinity;
  let levelVote = 0;
  if (toSupport <= 0.5 && toSupport < toResistance) levelVote = 1; // pegado al soporte: posible rebote
  else if (toResistance <= 0.5 && toResistance < toSupport) levelVote = -1; // pegado a la resistencia
  const touches = (l) => `${l.touches} ${l.touches === 1 ? 'toque' : 'toques'}`;
  const level = {
    key: 'level',
    name: 'Nivel abajo',
    text: below ? distance(price - below.value) : 'en mínimos',
    lean: leanOf(levelVote),
    vote: levelVote,
    support: below ? { distance: round1(toSupport), touches: below.touches, pips: pips ? inPips(price - below.value) : null } : null,
    resistance: above ? { distance: round1(toResistance), touches: above.touches, pips: pips ? inPips(above.value - price) : null } : null,
    detail:
      (below ? `Soporte a ${distance(price - below.value)} por debajo (${touches(below)}).` : 'No hay soporte por debajo en lo que he visto: el precio está en mínimos.') +
      (above ? ` Resistencia a ${distance(above.value - price)} por encima (${touches(above)}).` : ' Sin resistencia por encima: precio en máximos.'),
  };

  // 7) Sesion
  const sessionInfo = sessionAt(time, asset);
  const session = { key: 'session', name: 'Sesión', text: sessionInfo.text, lean: 'flat', vote: 0, detail: sessionInfo.detail };

  // Agotamiento: que algo vaya subiendo no significa que siga. Cuenta en contra del movimiento
  // una racha larga de velas del mismo color, o el precio en el extremo de todo lo visto con RSI alto/bajo.
  const lastDir = all[count - 1].dir;
  let streak = 1;
  for (let i = count - 2; i >= 0 && lastDir !== 'flat' && all[i].dir === lastDir; i--) streak++;
  const seen = all.slice(-LEVEL_CANDLES);
  const atTop = seen.length >= 10 && Math.max(...seen.map((c) => c.high)) - price <= unit * 0.3;
  const atBottom = seen.length >= 10 && price - Math.min(...seen.map((c) => c.low)) <= unit * 0.3;
  let tired = 0;
  const signs = [];
  if (streak >= 4 && lastDir === 'up') (tired -= 1), signs.push(`${streak} velas verdes seguidas`);
  if (streak >= 4 && lastDir === 'down') (tired += 1), signs.push(`${streak} velas rojas seguidas`);
  if (atTop && strength >= 65) (tired -= 1), signs.push('precio en el máximo de lo visto con RSI alto');
  if (atBottom && strength <= 35) (tired += 1), signs.push('precio en el mínimo de lo visto con RSI bajo');
  const exhaustion = { key: 'exhaustion', vote: Math.sign(tired), signs };

  // 8) Resumen: cuantas lecturas apuntan a cada lado
  const voters = [trend, ema, momentum, rsiReading, level, exhaustion];
  const ups = voters.filter((r) => r.vote > 0).length;
  const downs = voters.filter((r) => r.vote < 0).length;
  const balance = ups - downs;
  // Hasta 2 votos en la decision: lo mas reciente (precio y vela actual) sigue pesando mas.
  const vote = Math.abs(balance) >= 3 ? 2 * Math.sign(balance) : Math.sign(balance);
  // Por separado: las lecturas que siguen el movimiento y las que apuestan al regreso
  // (segun el patron medido en el precio real cuentan unas u otras; ver decide en timed.js).
  const group = (list) => {
    const sum = list.reduce((s, r) => s + Math.sign(r.vote), 0);
    return Math.abs(sum) >= 2 ? 2 * Math.sign(sum) : Math.sign(sum);
  };
  const follow = group([trend, ema, momentum]);
  const reverse = group([rsiReading, level, exhaustion]);
  const text = `${ups} arriba, ${downs} abajo`;
  const summary = {
    key: 'summary',
    name: 'Resumen',
    text: `▲ ${ups} · ▼ ${downs}`,
    lean: leanOf(balance),
    vote,
    detail:
      `De 6 lecturas con dirección (tendencia, EMA, momentum, RSI, nivel, agotamiento): ${text}. ` +
      `Aporta ${Math.abs(vote)} ${Math.abs(vote) === 1 ? 'voto' : 'votos'} a la señal.` +
      (signs.length ? ` Agotamiento: ${signs.join('; ')}.` : ''),
  };

  return {
    items: [trend, ema, momentum, rsiReading, move, level, session, summary],
    vote,
    follow,
    reverse,
    text,
    candles: count,
    // Filas (pixeles de la imagen) del soporte y la resistencia encontrados, para dibujarlos.
    rows: { support: below ? -below.value : null, resistance: above ? -above.value : null },
    // Version en numeros, para la IA.
    data: {
      velas_en_historial: count,
      tendencia: { velas: trendCount, direccion: trend.lean, avance_en_velas: inUnits(drift) },
      ema: pair ? { periodos: pair, rapida_respecto_a_lenta: ema.lean } : null,
      momentum: { avance_ultimas_velas: inUnits(roc), velas: back, ahora_mismo: live ? live.text : 'quieto' },
      rsi: strength,
      movimiento_ultimo_minuto:
        move.swing === undefined
          ? null
          : { oscilacion: move.swing, neto: move.net, ...(pips ? { oscilacion_pips: move.swingPips, neto_pips: move.netPips } : {}) },
      soporte_abajo: level.support
        ? { distancia: level.support.distance, toques: level.support.touches, ...(pips ? { distancia_pips: level.support.pips } : {}) }
        : null,
      resistencia_arriba: level.resistance
        ? { distancia: level.resistance.distance, toques: level.resistance.touches, ...(pips ? { distancia_pips: level.resistance.pips } : {}) }
        : null,
      ...(pips ? { vela_tipica_en_pips: inPips(unit) } : {}),
      agotamiento: {
        velas_seguidas_del_mismo_color: streak,
        color: lastDir === 'up' ? 'verde' : lastDir === 'down' ? 'roja' : 'plana',
        precio_en_maximo_de_lo_visto: atTop,
        precio_en_minimo_de_lo_visto: atBottom,
      },
      sesion: session.text,
      resumen: text,
    },
  };
}

module.exports = { computeReadings, findLevels, sessionAt, emaSeries, EMA_PAIRS };
