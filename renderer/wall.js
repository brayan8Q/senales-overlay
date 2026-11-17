/**
 * LAS 4 GRÁFICAS PROPIAS DEL PANEL (16 nov 2026).
 *
 * Cada gráfica se dibuja aquí con las velas de 15 s que el bot recibe de Pocket: el par de cada lugar, la vela actual
 * resaltada con su reloj, por qué entra o no entra, la entrada del bot mientras está abierta y cómo terminó cada
 * operación. Los pares cambian solos (son datos, no páginas). No hay botones de compra ni venta: solo se mira.
 */
/* global wallMath */
const api = window.senales;
const COLORS = { up: '#22c55e', down: '#ef4444', flat: '#94a3b8', grid: 'rgba(148,163,184,.14)', text: '#cbd5e1', dim: '#64748b', now: '#38bdf8', gold: '#fde047', bg: '#0b1220' };
const PITCH = 13; // paso de una vela, en puntos
const AXIS = 66; // ancho del eje de precios
let state = null;
let stateAt = 0;

const cells = Array.from(document.querySelectorAll('.cell')).map((el) => ({
  el,
  title: el.querySelector('.title'),
  status: el.querySelector('.status'),
  canvas: el.querySelector('canvas'),
}));

function fit(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(50, Math.floor(canvas.clientWidth));
  const height = Math.max(50, Math.floor(canvas.clientHeight));
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function statusOf(slot, minMargin) {
  const arrow = slot.dir === 'up' ? '▲ ARRIBA' : slot.dir === 'down' ? '▼ ABAJO' : '';
  if (!slot.name) return { text: 'sin par', tone: 'off' };
  if (slot.order) return { text: `EL BOT ENTRÓ ${slot.order.dir === 'up' ? '▲ ARRIBA' : '▼ ABAJO'}${slot.order.amount ? ` · $${Number(slot.order.amount).toFixed(2)}` : ''}${slot.order.level ? ` · martingala ${slot.order.level}` : ''}`, tone: 'open' };
  if (slot.last && Date.now() - slot.last.at < 4000) {
    const won = slot.last.result === 'win';
    return { text: `${won ? 'GANÓ' : slot.last.result === 'loss' ? 'PERDIÓ' : 'EMPATE'} ${slot.last.net >= 0 ? '+' : ''}${Number(slot.last.net).toFixed(2)}`, tone: won ? 'win' : slot.last.result === 'loss' ? 'loss' : 'off' };
  }
  if (!slot.ready) return { text: slot.found === false ? 'el bot no tiene ese par' : 'juntando velas…', tone: 'off' };
  if (slot.rest > 0 && slot.why !== '') return { text: `perdió aquí: descansa ${slot.rest} s${arrow ? ` · ${arrow} ${slot.margin}` : ''}`, tone: 'off' };
  if (slot.why) return { text: `${arrow ? `${arrow} · ${slot.margin} de ventaja · ${slot.pattern} · ` : ''}NO ENTRO: ${slot.why}`, tone: 'off' };
  return { text: `${arrow} · ${slot.margin} de ventaja · ${slot.pattern} · CONFIANZA MUY ALTA: ENTRO`, tone: slot.dir || 'off' };
}

function drawChart(cell, slot, now) {
  const { ctx, width, height } = fit(cell.canvas);
  ctx.clearRect(0, 0, width, height);
  const all = slot && slot.closed ? [...slot.closed, slot.forming].filter(Boolean) : [];
  if (all.length < 2) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(slot && slot.name ? 'Esperando las velas del bot…' : 'Lugar vacío', width / 2, height / 2);
    return;
  }
  const plotW = width - AXIS - 6;
  const top = 10;
  const plotH = height - top - 26;
  const count = Math.min(all.length, wallMath.visibleCount(plotW - PITCH * 2.5, PITCH));
  const candles = all.slice(-count);
  const order = slot.order;
  const scale = wallMath.scaleOf(candles, top, plotH, order && order.openPrice ? [order.openPrice] : []);
  if (!scale) return;
  const digits = wallMath.digitsFor(candles[candles.length - 1].close);
  const xOf = (i) => 6 + i * PITCH + PITCH / 2;
  const body = Math.max(3, PITCH - 4);

  // Rejilla y eje de precios
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const price of wallMath.gridPrices(scale.min, scale.max, 5)) {
    const y = Math.round(scale.y(price)) + 0.5;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width - AXIS, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.dim;
    ctx.fillText(price.toFixed(digits), width - AXIS + 6, y);
  }

  // Velas
  candles.forEach((c, i) => {
    const x = Math.round(xOf(i));
    const color = c.close > c.open ? COLORS.up : c.close < c.open ? COLORS.down : COLORS.flat;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, scale.y(c.high));
    ctx.lineTo(x + 0.5, scale.y(c.low));
    ctx.stroke();
    const y0 = scale.y(Math.max(c.open, c.close));
    const y1 = scale.y(Math.min(c.open, c.close));
    ctx.fillRect(x - body / 2, y0, body, Math.max(1.5, y1 - y0));
  });

  // Operaciones ya cerradas a la vista: triángulo verde (ganó) o rojo (perdió) en la vela donde se entró
  const formingStart = stateAt - (Number(slot.openFor) || 0) * 1000;
  for (const trade of slot.trades || []) {
    const index = wallMath.indexAt(candles.length, formingStart, trade.openedAt);
    if (index === null || !Number.isFinite(trade.openPrice)) continue;
    const x = xOf(index);
    const y = scale.y(trade.openPrice);
    ctx.fillStyle = trade.result === 'win' ? COLORS.up : trade.result === 'loss' ? COLORS.down : COLORS.flat;
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (trade.dir === 'up') {
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x - 6, y + 4);
      ctx.lineTo(x + 6, y + 4);
    } else {
      ctx.moveTo(x, y + 7);
      ctx.lineTo(x - 6, y - 4);
      ctx.lineTo(x + 6, y - 4);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Vela actual: recuadro amarillo, y su reloj debajo
  const last = candles[candles.length - 1];
  const lx = xOf(candles.length - 1);
  const ly0 = scale.y(last.high);
  const ly1 = scale.y(last.low);
  ctx.strokeStyle = COLORS.gold;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(253,224,71,.7)';
  ctx.shadowBlur = 8;
  ctx.strokeRect(lx - body / 2 - 3, ly0 - 3, body + 6, Math.max(6, ly1 - ly0 + 6));
  ctx.shadowBlur = 0;
  const elapsed = Math.max(0, Math.min(15, (Number(slot.openFor) || 0) + (now - stateAt) / 1000));
  const clockY = height - 20;
  ctx.fillStyle = 'rgba(148,163,184,.25)';
  ctx.fillRect(lx - 22, clockY, 44, 4);
  ctx.fillStyle = COLORS.gold;
  ctx.fillRect(lx - 22, clockY, (44 * elapsed) / 15, 4);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.gold;
  ctx.fillText(`vela actual · ${Math.floor(elapsed)} de 15 s`, Math.min(width - AXIS - 62, Math.max(62, lx)), clockY + 13);

  // Precio de ahora: línea punteada y etiqueta en el eje
  const py = Math.round(scale.y(last.close)) + 0.5;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.now;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, py);
  ctx.lineTo(width - AXIS, py);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.now;
  ctx.fillRect(width - AXIS + 2, py - 9, AXIS - 4, 18);
  ctx.fillStyle = '#0b1220';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(last.close.toFixed(digits), width - AXIS + 6, py);

  // Operación abierta: línea en el precio de entrada y flecha hacia donde apostó
  if (order && Number.isFinite(order.openPrice)) {
    const oy = Math.round(scale.y(order.openPrice)) + 0.5;
    ctx.strokeStyle = COLORS.gold;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, oy);
    ctx.lineTo(width - AXIS, oy);
    ctx.stroke();
    const index = wallMath.indexAt(candles.length, formingStart, order.openedAt);
    const ox = xOf(index === null ? candles.length - 1 : index);
    ctx.fillStyle = COLORS.gold;
    ctx.beginPath();
    if (order.dir === 'up') {
      ctx.moveTo(ox, oy - 14);
      ctx.lineTo(ox - 8, oy - 2);
      ctx.lineTo(ox + 8, oy - 2);
    } else {
      ctx.moveTo(ox, oy + 14);
      ctx.lineTo(ox - 8, oy + 2);
      ctx.lineTo(ox + 8, oy + 2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const winning = order.dir === 'up' ? last.close > order.openPrice : last.close < order.openPrice;
    ctx.fillStyle = winning ? COLORS.up : last.close === order.openPrice ? COLORS.text : COLORS.down;
    ctx.fillText(`entrada ${order.openPrice.toFixed(digits)} · ${winning ? 'va ganando' : last.close === order.openPrice ? 'va igual' : 'va perdiendo'}`, 8, oy + (order.dir === 'up' ? 12 : -12));
  }
}

function render() {
  const now = Date.now();
  const s = state;
  const stale = !s || now - stateAt > 5000;
  document.body.classList.toggle('stale', stale);
  $summary(s, stale);
  cells.forEach((cell, i) => {
    const slot = s && s.slots ? s.slots[i] : null;
    const status = slot ? statusOf(slot, s.minMargin) : { text: 'sin datos del panel', tone: 'off' };
    cell.title.textContent = slot && slot.name ? `${i + 1} · ${slot.name}${slot.payout ? ` · paga ${slot.payout} %` : ''}` : `${i + 1} · sin par`;
    cell.status.textContent = status.text;
    cell.status.className = `status ${status.tone}`;
    cell.el.className = `cell ${status.tone === 'open' || status.tone === 'win' || status.tone === 'loss' ? status.tone : ''}${s && s.pick && slot && s.pick === slot.name && !slot.order ? ' pick' : ''}`;
    try {
      drawChart(cell, slot, now);
    } catch (err) {
      cell.status.textContent = `no se pudo dibujar: ${err.message}`;
    }
  });
}

function $summary(s, stale) {
  const bar = document.getElementById('summary');
  if (!s) {
    bar.textContent = 'Esperando al panel…';
    return;
  }
  const t = s.tally || { wins: 0, losses: 0, ties: 0, net: 0 };
  const n = t.wins + t.losses;
  const rate = n ? ` · acierto ${Math.round((1000 * t.wins) / n) / 10} %` : '';
  bar.textContent = stale
    ? 'Sin datos nuevos del bot (¿está abierta la ventana «Pocket Lector DEMO»?)'
    : `${s.on ? 'Bot DEMO operando' : `Bot en espera: ${s.why || 'apagado'}`} · lleva ${t.wins} ganadas / ${t.losses} perdidas${t.ties ? ` / ${t.ties} empates` : ''}${rate} · neto ${t.net >= 0 ? '+' : ''}${Number(t.net).toFixed(2)}${s.rules ? ` · entra solo con: ${s.rules}` : ''}`;
}

api.onWall((next) => {
  state = next;
  stateAt = Date.now();
  render();
});
setInterval(render, 250); // el reloj de la vela y los avisos avanzan aunque no llegue nada nuevo
window.addEventListener('resize', render);
api.wallReady();
