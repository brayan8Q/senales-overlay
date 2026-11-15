/**
 * FUENTE INTERNA de precios y velas (15 nov 2026).
 *
 * En vez de leer los números de la pantalla (píxeles), se leen de los datos que la propia
 * terminal demo de Pocket Option recibe por su conexión (socket.io sobre websocket). Este
 * módulo solo ESCUCHA: no manda nada a la plataforma ni toca ninguna cuenta.
 *
 * Lo que llega (comprobado en la terminal demo el 15 nov 2026):
 *   451-["updateStream",{"_placeholder":true,"num":0}]   y, en el siguiente mensaje (binario),
 *       [["EURUSD_otc",1794779538.514,1.04762]]           precio: [activo, hora (s), precio], 2 por segundo
 *   451-["updateHistoryNewFast",{...}]                    y, en el siguiente (binario),
 *       {"asset":"EURUSD_otc","period":15,
 *        "history":[[hora,precio],...],                   precios de los últimos ~8 minutos
 *        "candles":[[hora,apertura,cierre,máximo,mínimo],...]}   velas más viejas (la más nueva primero)
 *   451-["updateAssets",{...}]  y  [[id,"EURUSD_otc","EUR/USD OTC","currency",5,PAGO,...],...]
 *   (saliente) 42["changeSymbol",{"asset":"EURUSD_otc","period":15}]   el activo que muestra la gráfica
 *
 * Las velas se arman con los precios: cada vela empieza en un múltiplo de su duración (hora del
 * servidor), abre en el primer precio y cierra en el último. Así no importa en qué temporalidad
 * o tipo de gráfica esté la terminal: se arman las de la duración que haga falta. (Comprobado:
 * las velas armadas así salen idénticas a las que manda el servidor.)
 *
 * Si el formato de la plataforma cambia, este lector deja de recibir datos, la "edad" del último
 * dato crece y el panel vuelve solo a la lectura por píxeles.
 */
const TICK_MEMORY_S = 45 * 60; // precios que se guardan por activo
const STALE_MS = 5000; // sin dato nuevo en este tiempo, la fuente se da por caída
const PERIODS = [5, 10, 15, 30, 60, 120, 180, 300]; // duraciones de vela que ofrece la plataforma (s)

/** Nombre de activo comparable: "EUR/USD OTC" y "EURUSD_otc" dan "eurusdotc". */
const assetKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const decimalsOf = (value) => {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 || text.includes('e') ? 0 : Math.min(8, text.length - dot - 1);
};
const validTick = (t) => Array.isArray(t) && Number.isFinite(t[0]) && Number.isFinite(t[1]);

function createFeed() {
  let pending = null; // evento que espera su dato en el siguiente mensaje binario
  let chart = { asset: null, period: null }; // lo que muestra la gráfica de la terminal
  let frames = 0;
  let lastFrameAt = 0;
  const series = new Map(); // activo -> { ticks: [[hora, precio]], lastAt: ms locales, decimals }
  const serverCandles = new Map(); // "activo|periodo" -> Map(hora -> vela)
  const assets = new Map(); // activo -> { name, payout }

  /** Agrega precios a un activo (ordenados por hora, sin repetidos). */
  function addTicks(asset, list, now) {
    if (!list.length) return;
    let s = series.get(asset);
    if (!s) {
      s = { ticks: [], lastAt: 0, decimals: 0 };
      series.set(asset, s);
    }
    const lastTime = s.ticks.length ? s.ticks[s.ticks.length - 1][0] : -Infinity;
    if (list[0][0] > lastTime) {
      for (const t of list) if (t[0] > (s.ticks.length ? s.ticks[s.ticks.length - 1][0] : -Infinity)) s.ticks.push([t[0], t[1]]);
    } else {
      // Historial que se solapa con lo que ya hay: se juntan y se ordenan.
      const byTime = new Map();
      for (const t of s.ticks) byTime.set(t[0], t[1]);
      for (const t of list) byTime.set(t[0], t[1]);
      s.ticks = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
    }
    const newest = s.ticks[s.ticks.length - 1][0];
    if (newest > lastTime) s.lastAt = now;
    const from = newest - TICK_MEMORY_S;
    if (s.ticks[0][0] < from) s.ticks = s.ticks.filter((t) => t[0] >= from);
    for (const t of list.slice(-20)) s.decimals = Math.max(s.decimals, decimalsOf(t[1]));
  }

  function handle(name, data, now) {
    if (name === 'updateStream' && Array.isArray(data)) {
      for (const t of data) {
        if (Array.isArray(t) && typeof t[0] === 'string' && Number.isFinite(t[1]) && Number.isFinite(t[2])) addTicks(t[0], [[t[1], t[2]]], now);
      }
    } else if (/^(updateHistory|loadHistory)/.test(name) && data && typeof data === 'object' && typeof data.asset === 'string') {
      const period = Number(data.period) || null;
      chart = { asset: data.asset, period };
      if (Array.isArray(data.history)) addTicks(data.asset, data.history.filter(validTick), now);
      if (Array.isArray(data.candles) && period) {
        const key = `${data.asset}|${period}`;
        const map = serverCandles.get(key) || new Map();
        for (const c of data.candles) {
          if (Array.isArray(c) && c.slice(0, 5).every(Number.isFinite)) map.set(c[0], { time: c[0], open: c[1], close: c[2], high: c[3], low: c[4] });
        }
        serverCandles.set(key, map);
      }
    } else if (name === 'updateAssets' && Array.isArray(data)) {
      for (const a of data) {
        if (Array.isArray(a) && typeof a[1] === 'string') assets.set(a[1], { name: String(a[2] || a[1]), payout: Number.isFinite(a[5]) ? a[5] : null });
      }
    }
  }

  return {
    /**
     * Un mensaje del websocket de la terminal.
     * @param {string|Buffer} payload  Texto, o el contenido binario (Buffer, o base64 como lo entrega CDP).
     * @param {{binary?:boolean, sent?:boolean, now:number}} info  sent = lo mandó la página (no lo recibió).
     */
    onFrame(payload, { binary = false, sent = false, now }) {
      frames++;
      lastFrameAt = now;
      let text;
      try {
        text = binary ? (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'base64')).toString('utf8') : String(payload);
      } catch {
        return;
      }
      try {
        if (sent) {
          // De lo que manda la página solo interesa a qué activo cambió la gráfica.
          const out = /^42(\[.*\])$/s.exec(text);
          if (!out) return;
          const [name, arg] = JSON.parse(out[1]);
          if (name === 'changeSymbol' && arg && typeof arg.asset === 'string') chart = { asset: arg.asset, period: Number(arg.period) || null };
          return;
        }
        if (binary) {
          const name = pending;
          pending = null;
          if (name) handle(name, JSON.parse(text), now);
          return;
        }
        const withAttachment = /^45\d+-(\[.*\])$/s.exec(text);
        if (withAttachment) {
          pending = JSON.parse(withAttachment[1])[0];
          return;
        }
        const plain = /^42(\[.*\])$/s.exec(text);
        if (plain) {
          const [name, data] = JSON.parse(plain[1]);
          handle(name, data, now);
        }
      } catch {
        pending = null; // mensaje que no se entiende: se ignora
      }
    },

    /**
     * Estado de un activo: precio, velas de `period` segundos y reloj de la vela en curso.
     * @param {{now:number, period:number, asset?:string}} query  asset = nombre como lo escribe el
     *        usuario ("EUR/USD OTC"); vacío = el que muestre la terminal.
     */
    snapshot({ now, period, asset = '' }) {
      const want = assetKey(asset);
      const names = [...series.keys()];
      let name = null;
      if (want) name = names.find((n) => assetKey(n) === want) || null;
      else name = chart.asset && series.has(chart.asset) ? chart.asset : names[names.length - 1] || null;
      const shown = chart.asset ? (assets.get(chart.asset) || {}).name || chart.asset : null;
      if (!name) {
        // Otro par solo si de verdad es otro: si es el mismo, es que sus precios aun no llegan.
        const other = Boolean(want && chart.asset && assetKey(chart.asset) !== want);
        const reason = !frames ? 'la fuente interna aún no entrega datos' : other ? `la fuente interna está en otro par (${shown})` : 'la fuente interna no tiene precios todavía';
        return { ok: false, reason, chartAsset: chart.asset, wrongAsset: other };
      }
      const s = series.get(name);
      const lastTick = s.ticks[s.ticks.length - 1];
      const ageMs = Math.max(0, now - s.lastAt);
      // La terminal ya muestra otro activo y de este dejaron de llegar precios: se dice asi.
      if (want && chart.asset && assetKey(chart.asset) !== want && ageMs > STALE_MS) {
        return { ok: false, reason: `la fuente interna está en otro par (${shown})`, chartAsset: chart.asset, wrongAsset: true };
      }
      const serverNow = lastTick[0] + ageMs / 1000;
      const P = period;
      const current = Math.floor(serverNow / P) * P;

      // Velas: primero las del servidor (si son de esta duración), luego las armadas con precios.
      const candles = new Map();
      const fromServer = serverCandles.get(`${name}|${P}`);
      if (fromServer) for (const [time, c] of fromServer) candles.set(time, c);
      let firstBucket = null;
      const built = new Map();
      for (const [time, price] of s.ticks) {
        const bucket = Math.floor(time / P) * P;
        if (firstBucket === null) firstBucket = bucket;
        const c = built.get(bucket);
        if (!c) built.set(bucket, { time: bucket, open: price, high: price, low: price, close: price });
        else {
          if (price > c.high) c.high = price;
          if (price < c.low) c.low = price;
          c.close = price;
        }
      }
      for (const [bucket, c] of built) {
        // La primera vela armada suele estar incompleta (los precios empiezan a media vela): solo
        // vale si el servidor no mandó la suya y los precios arrancan justo al abrir.
        if (bucket === firstBucket && (candles.has(bucket) || s.ticks[0][0] - bucket > 1)) continue;
        candles.set(bucket, c);
      }
      // Solo el tramo final sin huecos: una vela que falta partiría las rachas y los extremos.
      const closed = [];
      for (let time = current - P; candles.has(time); time -= P) closed.unshift(candles.get(time));
      const live = candles.get(current);
      const forming = live || { time: current, open: lastTick[1], high: lastTick[1], low: lastTick[1], close: lastTick[1] };
      const elapsedMs = Math.max(0, (serverNow - current) * 1000);
      const info = assets.get(name) || null;
      return {
        ok: true,
        asset: name,
        label: info ? info.name : name,
        period: P,
        ageMs,
        stale: ageMs > STALE_MS,
        price: lastTick[1],
        priceTime: lastTick[0],
        decimals: s.decimals,
        closed,
        forming,
        clock: { startedAt: now - elapsedMs, elapsedMs, remainingMs: Math.max(0, P * 1000 - elapsedMs) },
        payout: info ? info.payout : null, // pago base del activo según la plataforma (%)
      };
    },

    /**
     * Nombre interno de un par ("EUR/USD OTC" -> "EURUSD_otc"), segun la lista de activos que
     * mando la terminal; null si no esta en la lista (o la lista aun no llega).
     */
    symbolFor(name) {
      const want = assetKey(name);
      if (!want) return null;
      for (const [symbol, info] of assets) {
        if (assetKey(symbol) === want || assetKey(info.name) === want) return symbol;
      }
      return null;
    },

    /** Resumen para el indicador de salud. */
    status() {
      const info = chart.asset ? assets.get(chart.asset) : null;
      return { frames, lastFrameAt, chartAsset: chart.asset, chartLabel: info ? info.name : chart.asset, chartPeriod: chart.period, assets: assets.size };
    },

    reset() {
      pending = null;
      chart = { asset: null, period: null };
      series.clear();
      serverCandles.clear();
    },
  };
}

module.exports = { createFeed, assetKey, STALE_MS, PERIODS };
