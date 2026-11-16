/* Panel flotante compacto: señal, barra de análisis, lecturas y contador. */
const $ = (id) => document.getElementById(id);
// OJO: no llamar a esta constante igual que el puente (window.senales): redeclararlo detiene el script.
const api = window.senales;

const panel = $('panel');
const selector = $('selector');
const selRect = $('sel-rect');

let selecting = false;
let dragging = false;
let settingsOpen = false;

// ---------- Clics que atraviesan la ventana ----------
panel.addEventListener('mouseenter', () => api.setIgnore(false));
panel.addEventListener('mouseleave', () => {
  if (!dragging && !selecting) api.setIgnore(true);
});

// ---------- Mover el panel ----------
let dragOffset = null;
$('panel-header').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) return;
  const r = panel.getBoundingClientRect();
  dragOffset = { x: e.clientX - r.left, y: e.clientY - r.top };
  dragging = true;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const maxX = window.innerWidth - panel.offsetWidth;
  const maxY = window.innerHeight - panel.offsetHeight;
  panel.style.left = Math.min(Math.max(0, e.clientX - dragOffset.x), maxX) + 'px';
  panel.style.top = Math.min(Math.max(0, e.clientY - dragOffset.y), maxY) + 'px';
  panel.style.right = 'auto';
});
window.addEventListener('mouseup', () => {
  dragging = false;
});

// ---------- Marcar la zona con el raton ----------
let selStart = null;

function place(el, r) {
  el.style.left = r.x + 'px';
  el.style.top = r.y + 'px';
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
}
function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
function startSelect() {
  selecting = true;
  selStart = null;
  selRect.classList.add('hidden');
  selector.classList.remove('hidden');
  api.setIgnore(false);
}
function endSelect() {
  selecting = false;
  selStart = null;
  selector.classList.add('hidden');
  selRect.classList.add('hidden');
  api.setIgnore(true);
}
selector.addEventListener('mousedown', (e) => {
  selStart = { x: e.clientX, y: e.clientY };
  place(selRect, { x: e.clientX, y: e.clientY, width: 0, height: 0 });
  selRect.classList.remove('hidden');
});
selector.addEventListener('mousemove', (e) => {
  if (selStart) place(selRect, rectFrom(selStart, { x: e.clientX, y: e.clientY }));
});
selector.addEventListener('mouseup', (e) => {
  if (!selStart || !selecting) return;
  const r = rectFrom(selStart, { x: e.clientX, y: e.clientY });
  endSelect();
  if (r.width >= 60 && r.height >= 40) api.setRegion(r);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selecting) endSelect();
});

// ---------- Botones ----------
function showSettings(open) {
  settingsOpen = open;
  $('settings').classList.toggle('hidden', !open);
  $('btn-settings').classList.toggle('on', open);
  panel.classList.toggle('wide', open); // los ajustes necesitan el ancho completo
}

// Panel compacto (por defecto): solo la señal, su % de confianza, el botón y el marcador.
// El botón ▾ de la cabecera muestra u oculta el detalle (lecturas, patrón, memoria...).
let compact = true;
try {
  compact = localStorage.getItem('panel-detalle') !== '1';
} catch {
  /* sin almacenamiento: se queda compacto */
}
function applyCompact() {
  panel.classList.toggle('compact', compact);
  $('btn-details').textContent = compact ? '▾' : '▴';
  $('btn-details').classList.toggle('on', !compact);
}
$('btn-details').addEventListener('click', () => {
  compact = !compact;
  try {
    localStorage.setItem('panel-detalle', compact ? '0' : '1');
  } catch {
    /* no es critico */
  }
  applyCompact();
});
applyCompact();
$('btn-settings').addEventListener('click', () => showSettings(!settingsOpen));
$('btn-zone').addEventListener('click', startSelect);
$('btn-auto').addEventListener('click', () => api.toggleAuto());
$('btn-reset').addEventListener('click', () => api.reset());
$('btn-debug').addEventListener('click', () => api.saveDebug());
$('btn-quit').addEventListener('click', () => api.quit());
$('payout').addEventListener('change', (e) => api.setPayout(Number(e.target.value)));
$('cycle').addEventListener('change', (e) => api.setCycle(Number(e.target.value)));
$('pause').addEventListener('change', (e) => api.setPause(Number(e.target.value)));
$('always').addEventListener('change', (e) => api.setAlways(e.target.checked));
$('btn-predict').addEventListener('click', () => api.predict());
$('auto-mode').addEventListener('change', (e) => api.setManual(!e.target.checked));
$('instant').addEventListener('change', (e) => api.setInstant(e.target.checked));
$('asset').addEventListener('change', (e) => api.setAsset(e.target.value));
$('pattern-veto').addEventListener('change', (e) => api.setPatternVeto(e.target.checked));
$('anti-rebound').addEventListener('change', (e) => api.setAntiRebound(e.target.checked));
$('internal-source').addEventListener('change', (e) => api.setInternalSource(e.target.checked));
$('btn-visor').addEventListener('click', () => api.toggleVisor());
$('martin').addEventListener('change', (e) => api.setMartin(Number(e.target.value)));
$('entry-wait').addEventListener('change', (e) => api.setEntryWait(Number(e.target.value)));
$('auto-trade').addEventListener('change', (e) => api.setAutoTrade(e.target.checked));
$('new-candle').addEventListener('change', (e) => api.setNewCandle(e.target.checked));

// IA: tres proveedores, cada uno con su clave. Los de ChatGPT conservan sus ids de siempre.
const AI_BLOCKS = [
  { provider: 'openai', prefix: 'ai', button: 'btn-ai', hint: 'Pega aquí tu clave (sk-…)' },
  { provider: 'gemini', prefix: 'ai-gemini', button: 'btn-ai-gemini', hint: 'Pega aquí tu clave de Gemini' },
  { provider: 'claude', prefix: 'ai-claude', button: 'btn-ai-claude', hint: 'Pega aquí tu clave de Claude (sk-ant-…)' },
];
const shownModels = {}; // por proveedor, para no reconstruir la lista en cada actualización
for (const block of AI_BLOCKS) {
  const input = $(`${block.prefix}-key`);
  const save = () => {
    if (!input.value.trim()) return;
    api.aiSetKey(input.value, block.provider);
    input.value = ''; // la clave no se queda a la vista
  };
  $(`${block.button}-save`).addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  $(`${block.button}-clear`).addEventListener('click', () => api.aiClear(block.provider));
  $(`${block.prefix}-model`).addEventListener('change', (e) => api.aiSetModel(e.target.value, block.provider));
  $(`${block.button}-page`).addEventListener('click', () => api.aiOpenKeysPage(block.provider));
}

/** Pinta el estado de una IA en los ajustes: estado, modelos de su cuenta y botones. */
function renderAiBlock(block, info) {
  let consumo = '';
  if (info.enabled && info.usage.calls > 0) {
    const total = info.usage.priced ? ` · ~$${info.usage.cost.toFixed(3)} en total` : '';
    consumo = ` · ${info.usage.calls} consultas, ${info.usage.input} tokens de entrada y ${info.usage.output} de salida${total}`;
  }
  $(`${block.prefix}-status`).textContent = info.status + (info.enabled ? ` · clave ${info.hint}` : '') + consumo;
  $(`${block.button}-clear`).classList.toggle('hidden', !info.enabled);
  const models = info.models || [];
  $(`${block.prefix}-model-row`).classList.toggle('hidden', !info.enabled || models.length === 0);
  const select = $(`${block.prefix}-model`);
  if (models.join(',') !== (shownModels[block.provider] || '')) {
    shownModels[block.provider] = models.join(',');
    select.textContent = '';
    for (const id of models) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    }
  }
  if (document.activeElement !== select && info.model) select.value = info.model;
  $(`${block.prefix}-key`).placeholder = info.enabled ? 'Pega otra clave para cambiarla' : block.hint;
}

// ---------- Pintar el estado ----------
const SIGNAL_TEXT = { up: 'ARRIBA ▲', down: 'ABAJO ▼' };
let lastReadings = null; // se conservan durante el análisis para que no parpadeen
let firstState = true;

const READING_KEYS = ['trend', 'ema', 'momentum', 'rsi', 'move', 'level', 'session', 'summary'];

/** Pinta una de las 8 lecturas: nombre, valor, color y su mini-gráfica. */
function setChip(reading) {
  const chip = $(`chip-${reading.key}`);
  chip.className = `chip ${reading.lean || 'flat'}`;
  chip.querySelector('.chip-name').textContent = reading.name;
  chip.querySelector('.chip-value').textContent = reading.text;
  chip.title = `${reading.name}: ${reading.text}. ${reading.detail || ''}`;
  const svg = chip.querySelector('.chip-spark');
  const values = reading.spark || [];
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  svg.classList.toggle('empty', values.length < 2);
  if (values.length >= 2) {
    const points = values.map((v, i) => {
      const x = (i * 60) / (values.length - 1);
      const y = span ? 11 - ((v - min) / span) * 10 : 6; // valor mayor = más arriba
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    svg.querySelector('polyline').setAttribute('points', points.join(' '));
  }
}

/**
 * Escáner: dibuja sobre la gráfica lo que el panel leyó (un recuadro por vela, la vela actual,
 * soporte y resistencia) y dice si la lectura está verificada. Los recuadros aparecen de
 * izquierda a derecha, al paso del haz.
 */
let scanShown = 0; // cuántos recuadros hay dibujados (para no rehacerlos en cada actualización)
function renderScan(s) {
  const scan = s.scan;
  const who = s.ai.count ? ` · ${s.ai.names.join(' + ')}` : '';
  if (!scan) {
    $('scan-label').textContent = `ESCANEANDO VELAS${who}`;
    return;
  }
  const marks = $('scan-marks');
  if (scan.mode !== 'analysis') {
    // Fuera del análisis no hay recuadro por vela (se vuelven a revelar, al paso del haz, en el siguiente).
    if (scanShown) marks.textContent = '';
    scanShown = 0;
  } else {
    if (scanShown !== scan.candles.length) {
      marks.textContent = '';
      scan.candles.forEach((c, i) => {
        const mark = document.createElement('div');
        mark.className = 'scan-mark';
        mark.style.animationDelay = `${Math.round((i * 900) / scan.candles.length)}ms`;
        marks.appendChild(mark);
      });
      scanShown = scan.candles.length;
    }
    scan.candles.forEach((c, i) => {
      const mark = marks.children[i];
      mark.classList.toggle('current', i === scan.candles.length - 1);
      mark.style.left = `${c.x - 2}px`;
      mark.style.width = `${c.w + 4}px`;
      mark.style.top = `${c.y - 2}px`;
      mark.style.height = `${c.h + 4}px`;
    });
  }
  // Soporte y resistencia: la línea, cuántos toques tiene y si está vigente o invertido
  // (invertido = el precio lo cruzó una vez y ahora hace el papel contrario).
  for (const [id, level, name, was] of [
    ['scan-support', scan.support, 'soporte', 'era resistencia'],
    ['scan-resistance', scan.resistance, 'resistencia', 'era soporte'],
  ]) {
    $(id).classList.toggle('hidden', !level);
    if (!level) continue;
    $(id).style.top = `${level.row}px`;
    $(id).classList.toggle('flipped', level.flipped);
    const touches = `${level.touches} ${level.touches === 1 ? 'toque' : 'toques'}`;
    $(id).querySelector('span').textContent = `${name} · ${touches} · ${level.flipped ? `invertido (${was})` : 'vigente'}`;
  }
  $('scan').classList.toggle('signal', scan.mode === 'signal');
  // Con la señal abierta el haz sigue pasando (ver style.css). En reposo (o esperando la vela
  // siguiente) solo se sigue la vela actual: sin haz ni recuadros.
  $('scan').classList.toggle('follow', scan.mode === 'follow');
  renderCurrentCandle(scan.current);
  renderRuler(scan);
  renderEntry(scan);
  const state = scan.verified ? 'lectura verificada ✓' : 'verificando lectura…';
  const saved = scan.saved ? ` · ${scan.saved} en memoria` : '';
  const rate = scan.rate ? ` · ${scan.rate} lecturas/s` : '';
  const label = $('scan-label');
  label.classList.toggle('warn', Boolean(scan.missing));
  if (scan.missing) label.textContent = 'LA VELA ACTUAL NO ESTÁ A LA VISTA';
  else if (scan.mode === 'analysis') label.textContent = `ESCANEANDO · ${scan.candles.length} velas${saved} · ${state}${rate}${who}`;
  else if (scan.mode === 'signal') {
    // Con la señal abierta el escáner sigue pasando y analizando hasta que termina: se dice cómo va.
    const going = s.entryWait ? ' · esperando tu entrada' : s.follow && s.follow.state ? ` · va ${s.follow.state}` : '';
    const what = s.signal && s.signal.source === 'martingala' ? 'LA MARTINGALA' : 'LA SEÑAL';
    label.textContent = `ESCANEANDO ${what}${going} · ${state}${rate}`;
  } else label.textContent = `SIGUIENDO LA VELA ACTUAL · ${state}${rate}`;
}

/**
 * Regla de arriba del margen: el número de cada vela. La vela en curso va resaltada; su número solo
 * crece (con la fuente interna sale de la hora de la vela), así se ve que el seguimiento no retrocede.
 */
function renderRuler(scan) {
  const ruler = $('scan-ruler');
  const marks = scan.ruler || [];
  while (ruler.children.length > marks.length) ruler.lastChild.remove();
  while (ruler.children.length < marks.length) ruler.appendChild(document.createElement('span'));
  marks.forEach((mark, i) => {
    const el = ruler.children[i];
    el.textContent = String(mark.n).padStart(2, '0');
    el.className = mark.current ? 'current' : '';
    el.style.left = `${mark.x + mark.w / 2}px`;
  });
  ruler.title = scan.byTime ? 'Número de cada vela según su hora (fuente interna).' : 'Número de cada vela, contando los cierres vistos.';
}

/** Coloca un elemento del escáner (en puntos, relativos a la zona). */
function placeScan(id, box) {
  const el = $(id);
  el.classList.remove('hidden');
  for (const [key, value] of Object.entries(box)) el.style[key] = `${value}px`;
  return el;
}

/**
 * Seguimiento de la vela actual: recuadro exacto sobre el cuerpo, línea de las mechas con sus
 * extremos, línea de apertura, marcador del precio en vivo y reloj de la vela.
 */
function renderCurrentCandle(c) {
  const ids = ['scan-body', 'scan-wick', 'scan-high', 'scan-low', 'scan-open', 'scan-now', 'scan-info', 'scan-clock', 'scan-clock-text'];
  // Si la vela en curso no está a la vista no se marca ninguna (nunca una vela vieja).
  if (!c) {
    for (const id of ids) $(id).classList.add('hidden');
    return;
  }
  const pips = (v) => (v === null ? '' : `${v} pips`);
  const center = c.x + c.w / 2;
  // Cuerpo: recuadro justo sobre sus bordes (mínimo 3 px de alto para que se vea en una vela plana).
  const bodyHeight = Math.max(3, c.bodyBottom - c.bodyTop);
  placeScan('scan-body', { left: c.x - 1, width: c.w + 2, top: c.bodyTop - 1, height: bodyHeight + 2 });
  // Mechas: del máximo al mínimo, por el centro de la vela.
  placeScan('scan-wick', { left: center - 1, top: c.high, height: Math.max(0, c.low - c.high) });
  const high = placeScan('scan-high', { left: c.x - 4, width: c.w + 8, top: c.high - 1 });
  const low = placeScan('scan-low', { left: c.x - 4, width: c.w + 8, top: c.low - 1 });
  high.querySelector('b').textContent = c.upperPips ? `mecha ${pips(c.upperPips)}` : 'máx';
  low.querySelector('b').textContent = c.lowerPips ? `mecha ${pips(c.lowerPips)}` : 'mín';
  // Apertura y precio en vivo: rayas que salen de la vela hacia la derecha.
  placeScan('scan-open', { left: c.x - 8, width: c.w + 26, top: c.open - 1 });
  const now = placeScan('scan-now', { left: c.x - 8, width: c.w + 56, top: c.price - 1 });
  now.className = c.lean === 'up' ? 'up' : c.lean === 'down' ? 'down' : '';
  const arrow = c.lean === 'up' ? '▲' : c.lean === 'down' ? '▼' : '●';
  now.querySelector('b').textContent = `${arrow} ${c.quote || ''} ${c.moving || ''}`.replace(/\s+/g, ' ').trim();
  // Rótulo encima de la vela: su patrón y el tamaño del cuerpo.
  const body = c.bodyPips === null ? '' : ` · cuerpo ${c.up ? '+' : '−'}${c.bodyPips} pips`;
  const info = placeScan('scan-info', { left: center, top: Math.max(22, c.high - 12) });
  const figure = c.figure ? ` · figura: ${c.figure}` : '';
  info.textContent = `vela actual: ${c.pattern || (c.up ? 'verde' : 'roja')}${body}${figure}`;
  // Reloj de la vela: la barrita (cuánto lleva de lo que dura) y, en números, los segundos que
  // lleva y los que le faltan para cerrar.
  if (c.seconds && c.elapsed !== null) {
    const clock = placeScan('scan-clock', { left: c.x - 1, width: c.w + 2, top: c.low + 8 });
    clock.querySelector('i').style.width = `${Math.min(100, (100 * c.elapsed) / c.seconds)}%`;
  } else $('scan-clock').classList.add('hidden');
  const text = placeScan('scan-clock-text', { left: center, top: c.low + 15 });
  if (c.elapsed === null) text.textContent = 'reloj: esperando a ver cerrar una vela';
  else if (c.remaining === null) text.textContent = `lleva ${Math.floor(c.elapsed)} s · midiendo cuánto dura la vela`;
  else text.textContent = `lleva ${Math.floor(Math.min(c.elapsed, c.seconds))} s · faltan ${Math.ceil(c.remaining)} s`;
}

/**
 * Zona de entrada: dos líneas (la del mejor precio y la límite) y, entre las dos, la franja donde
 * está bien entrar. Se atenúa cuando el precio se sale de la zona.
 */
function renderZone(e, sell) {
  const zone = $('scan-zone');
  if (!e || !e.zone) {
    zone.classList.add('hidden');
    return;
  }
  const top = Math.min(e.zone.best, e.zone.limit);
  zone.classList.remove('hidden');
  zone.classList.toggle('sell', sell);
  zone.classList.toggle('out', e.zone.inside === false);
  zone.style.top = `${top}px`;
  zone.style.height = `${Math.max(2, Math.abs(e.zone.best - e.zone.limit))}px`;
  const prices = e.zone.bestQuote ? ` · ${sell ? e.zone.limitQuote : e.zone.bestQuote} – ${sell ? e.zone.bestQuote : e.zone.limitQuote}` : '';
  // Un solo rótulo, por fuera de la franja (encima de la línea de arriba), para que nada se encime.
  zone.querySelector('b').textContent = `${sell ? 'ZONA DE VENTA ▼' : 'ZONA DE COMPRA ▲'}${prices}${e.zone.inside === false ? ' · precio fuera' : ''}`;
  // Cada línea lleva su etiqueta al final, a la derecha. En una venta el mejor precio es la de
  // arriba y el límite la de abajo; en una compra, al revés.
  zone.querySelector('i').textContent = 'mejor precio';
  zone.querySelector('i').className = sell ? 'top' : 'bottom';
  zone.querySelector('u').textContent = 'límite';
  zone.querySelector('u').className = sell ? 'bottom' : 'top';
}

/** Durante la señal: línea en el precio de entrada y cuántos pips va a favor o en contra. */
function renderEntry(scan) {
  const el = $('scan-entry');
  const target = $('scan-target');
  if (scan.mode !== 'signal' || !scan.entry) {
    el.classList.add('hidden');
    target.classList.add('hidden');
    $('scan-zone').classList.add('hidden');
    return;
  }
  const e = scan.entry;
  const sell = e.dir === 'down';
  el.classList.remove('hidden');
  el.classList.toggle('sell', sell);
  el.classList.toggle('low', e.confidence === 'baja'); // punteada: el panel eligió un lado sin lectura clara
  el.style.top = `${e.row - 1}px`;
  // Franja hacia donde tiene que irse el precio: arriba de la línea en compra, abajo en venta.
  target.classList.remove('hidden');
  target.classList.toggle('sell', sell);
  target.style.top = `${sell ? e.row + 1 : e.row - 55}px`;
  // Entrada sugerida: línea de puntos mientras el precio no llega; firme desde que llega.
  el.classList.toggle('pending', Boolean(e.suggested) && !e.taken);
  // Con zona de entrada, la franja es la zona misma (entre sus dos líneas), no la de "hacia dónde".
  target.classList.toggle('hidden', Boolean(e.suggested) && (!e.taken || Boolean(e.zone)));
  renderZone(e, sell);
  el.classList.toggle('ref', Boolean(e.zone)); // con zona, la entrada es una raya fina de referencia
  let text = sell ? 'VENTA ▼ sugerida' : 'COMPRA ▲ sugerida';
  if (e.suggested) {
    const side = sell ? 'VENTA ▼' : 'COMPRA ▲';
    if (e.zone) text = `entrada ${sell ? '▼' : '▲'}`; // corto: la zona ya dice de qué lado es
    else text = e.taken ? `ENTRADA ${side} tomada aquí · ${e.kind}` : `ENTRA EN ${side} cuando el precio llegue aquí · ${e.kind}`;
  }
  if (e.quote) text += ` · ${e.quote}`;
  if (e.confidence === 'baja' && !e.zone) text += ' · confianza baja';
  if (e.pips !== null) text += e.pips > 0 ? ` · va ganando +${e.pips} pips` : e.pips < 0 ? ` · va perdiendo ${e.pips} pips` : ' · va igual';
  else if (e.suggested && e.taken) text += e.ahead > 0 ? ' · va ganando' : e.ahead < 0 ? ' · va perdiendo' : ' · va igual';
  el.querySelector('b').textContent = text;
}

/** "gpt-6-astra" -> "GPT-6 Astra" */
function modelLabel(id) {
  return String(id || '')
    .split('-')
    .map((part, i) => (i === 0 ? part.toUpperCase() : /^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)))
    .join('-')
    .replace(/-(?=[A-Z])/g, ' ');
}

/** Tiempo que falta, corto: "45 s" o, de un minuto en adelante, "4:12". */
function clockText(ms) {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Barra: durante el análisis avanza por pasos; durante la señal se vacía hasta calificarla. */
function renderProgress(s) {
  const bar = $('progress');
  const timed = s.cycleSeconds > 0;
  if (!timed || (s.phase !== 'analysis' && s.phase !== 'signal' && s.phase !== 'waiting')) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  if (s.phase === 'waiting') {
    // PREDECIR con la vela ya avanzada: cuenta regresiva hasta que abra la vela siguiente.
    bar.className = 'waiting';
    const total = Math.max(1, s.candleSeconds * 1000);
    $('progress-fill').style.width = s.clockKnown ? `${Math.round(Math.min(1, Math.max(0, 1 - s.remainingMs / total)) * 100)}%` : '100%';
    $('progress-text').textContent = s.clockKnown
      ? `Próxima vela en ${Math.ceil(s.remainingMs / 1000)} s`
      : 'Esperando la siguiente vela…';
  } else if (s.phase === 'analysis' && s.thinking) {
    // Martingala en análisis: sale al abrir la vela nueva (cuenta regresiva hasta ahí).
    const total = Math.max(1, (s.candleSeconds || s.pauseSeconds) * 1000);
    bar.className = 'analysis';
    $('progress-fill').style.width = `${Math.round(Math.min(1, Math.max(0, 1 - s.remainingMs / total)) * 100)}%`;
    $('progress-text').textContent = `Martingala ${s.thinking} · se analiza al iniciar la vela`;
  } else if (s.phase === 'analysis') {
    // Avanza por las 8 lecturas, como "analizando · 6 de 8".
    const steps = ['tendencia', 'EMA', 'momentum', 'RSI', 'mov. 1 min', 'nivel', 'sesión', 'resumen'];
    const total = Math.max(1, s.pauseSeconds * 1000);
    const done = Math.min(1, Math.max(0, 1 - s.remainingMs / total));
    const index = Math.min(steps.length - 1, Math.floor(done * steps.length));
    // Una IA: su nombre ("GPT-6 Astra analizando"). Varias: "Astra + Argon + Fable analizando".
    let who = 'Analizando';
    if (s.ai.count === 1) who = `${modelLabel(s.ai.model)} analizando`;
    else if (s.ai.count > 1) who = `${s.ai.names.join(' + ')} analizando`;
    bar.className = 'analysis';
    $('progress-fill').style.width = `${Math.round(done * 100)}%`;
    $('progress-text').textContent = `${who} · ${index + 1} de ${steps.length}: ${steps[index]}`;
  } else if (!s.signal || !s.signal.dir) {
    // No salió predicción (ESPERAR): el panel se libera en unos segundos para pedir otra.
    const total = Math.max(1, Math.min(s.cycleSeconds * 1000, 10000));
    bar.className = 'signal';
    $('progress-fill').style.width = `${Math.round(Math.min(1, s.remainingMs / total) * 100)}%`;
    $('progress-text').textContent = `Sin predicción · listo en ${clockText(s.remainingMs)}`;
  } else if (s.entryWait) {
    // Etapa 1: la señal ya salió y se espera tu entrada; el plazo empieza a contar cuando entres.
    bar.className = 'entry';
    $('progress-fill').style.width = `${Math.round(Math.min(1, s.entryWait.leftMs / Math.max(1, s.entryWait.totalMs)) * 100)}%`;
    $('progress-text').textContent = `ENTRA AHORA · te quedan ${clockText(s.entryWait.leftMs)}`;
  } else if (s.untilClose) {
    // La señal vale hasta el cierre de la vela: la barra se vacía con lo que le falta a la vela.
    const total = Math.max(1, s.candleSeconds * 1000);
    bar.className = 'signal';
    $('progress-fill').style.width = `${Math.round(Math.min(1, s.remainingMs / total) * 100)}%`;
    $('progress-text').textContent = s.remainingMs > 0 ? `Se califica al cierre de la vela · ${Math.ceil(s.remainingMs / 1000)} s` : 'Cerró la vela: calificando…';
  } else {
    const total = Math.max(1, s.cycleSeconds * 1000);
    bar.className = 'signal';
    $('progress-fill').style.width = `${Math.round(Math.min(1, s.remainingMs / total) * 100)}%`;
    $('progress-text').textContent = s.entered ? `Entraste · se califica en ${clockText(s.remainingMs)}` : `Se califica en ${clockText(s.remainingMs)}`;
  }
}

api.onState((s) => {
  // La primera vez, si falta marcar la zona, se abren los ajustes solos.
  if (firstState) {
    firstState = false;
    if (!s.region) showSettings(true);
  }

  // --- Señal ---
  const dir = s.signal && s.signal.dir;
  const analyzing = s.phase === 'analysis';
  const waiting = s.phase === 'waiting'; // PREDECIR pulsado con la vela avanzada: se espera a la siguiente
  const manual = s.manual && s.cycleSeconds > 0;
  const resting = manual && s.phase === 'idle'; // modo manual, esperando a que pulsen PREDECIR

  // Botón PREDECIR: activo solo cuando hay gráfica y no hay una predicción en curso (ni esperando,
  // ni analizando, ni con señal): así no se enciman predicciones.
  const predict = $('btn-predict');
  predict.classList.toggle('hidden', !manual);
  predict.disabled = !(resting && s.ready);
  const noSide = s.phase === 'signal' && !(s.signal && s.signal.dir); // salió ESPERAR: no hay predicción
  predict.textContent = waiting ? 'Esperando la vela…' : analyzing ? 'Analizando…' : noSide ? 'Sin predicción…' : s.phase === 'signal' ? (s.entryWait ? (s.bot && s.bot.online && !s.bot.pause ? 'Entrando…' : 'Esperando tu entrada') : 'Operación en curso') : 'PREDECIR';

  if (waiting) {
    $('signal').className = 'waiting';
    $('signal-label').textContent = s.newCandle ? (s.skipReason ? 'SIN ENTRADA EN ESTA VELA' : 'SIGUIENDO ESTA VELA') : 'ESPERANDO LA SIGUIENTE VELA';
    if (s.newCandle) {
      const next = `Próxima predicción al abrir la siguiente${s.clockKnown ? ` (en ${Math.ceil(s.remainingMs / 1000)} s)` : ''}.`;
      $('signal-detail').textContent = s.skipReason ? `${s.skipReason} ${next}` : next;
      $('signal-detail').title = s.skipReason || '';
    } else {
      $('signal-detail').textContent = s.clockKnown
        ? `La vela en curso ya va avanzada. La nueva abre en ${Math.ceil(s.remainingMs / 1000)} s: ahí empiezo el análisis.`
        : 'La vela en curso ya va avanzada. Empiezo el análisis en cuanto abra la nueva.';
    }
    $('signal-source').textContent = '';
  } else if (resting) {
    $('signal').className = 'wait';
    $('signal-label').textContent = 'LISTO';
    $('signal-detail').textContent = s.lastResult
      ? `La última señal ${s.lastResult}. Pulsa PREDECIR para otra.`
      : s.bot && s.bot.online && !s.bot.pause
        ? 'Escaneando sin parar. Pulsa PREDECIR: sale el lado al instante y el bot entra en la DEMO.'
        : 'Escaneando sin parar. Pulsa PREDECIR para pedir una señal.';
    $('signal-source').textContent = '';
  } else if (analyzing) {
    $('signal').className = s.newCandle && s.clockKnown ? 'waiting' : 'analysis';
    // Con la señal al abrir la vela, a media vela NO hay predicción: solo se espera la vela nueva
    // (el análisis corre por dentro). Así no parece que se predice a media vela.
    const atOpen = s.newCandle && s.clockKnown;
    $('signal-label').textContent = atOpen ? (s.thinking ? `MARTINGALA ${s.thinking}` : 'ANALIZANDO ESTA VELA') : s.thinking ? `MARTINGALA ${s.thinking}` : 'ANALIZANDO';
    if (s.thinking) {
      $('signal-detail').textContent = atOpen
        ? `La señal perdió. La martingala ${s.thinking} se analiza al iniciar la vela nueva y entra en cuanto la IA decide. Sigo escaneando.`
        : `La señal perdió. Sigo escaneando y analizo la martingala ${s.thinking}.`;
    } else if (atOpen) {
      $('signal-detail').textContent = 'La vela acaba de abrir: la IA mira cómo cerró la anterior y cómo arranca esta. En cuanto decide, entra.';
    } else {
      $('signal-detail').textContent = s.ai.enabled ? 'Leyendo las velas y consultando a la IA.' : 'Leyendo las velas y el movimiento del precio.';
    }
    $('signal-source').textContent = '';
  } else {
    // Una señal de confianza baja se ve rayada: el panel eligió un lado sin lectura clara.
    const low = Boolean(dir) && s.signal.confidence === 'baja';
    $('signal').className = (dir || 'wait') + (low ? ' low' : '');
    // Martingala de seguimiento: se dice así, con su lado.
    const martin = s.signal && s.signal.source === 'martingala';
    $('signal-label').textContent = martin ? (dir === 'up' ? 'MARTIN SUBE ▲' : 'MARTIN BAJA ▼') : SIGNAL_TEXT[dir] || 'ESPERAR';
    $('signal-detail').textContent = s.signal ? s.signal.reason : '';
    $('signal-detail').title = s.signal ? s.signal.reason : '';
    let source = s.signal && s.signal.source ? (s.signal.source === 'ia' ? 'IA' : 'reglas') : '';
    if (source && dir && s.signal.confidence) source += ` · ${s.signal.confidence}`;
    if (martin) source = `martingala ${s.signal.martin}${s.martinLevels > 1 ? ` de ${s.martinLevels}` : ''}`;
    // Señal vetada: se dice qué veto fue y hacia dónde iba.
    if (s.veto) source = `${s.veto.kind === 'patron' ? 'patrón desactivado' : s.veto.kind === 'vela' ? 'la vela cambió de color' : 'veto anti-rebote'} · iba ${s.veto.dir === 'up' ? 'ARRIBA' : 'ABAJO'}`;
    $('signal-source').textContent = source;
  }
  // Porcentaje de la señal en curso: el acierto MEDIDO de su patrón (últimas 100 operaciones de ese
  // patrón, a este plazo). Verde si supera el mínimo que pide el pago real; ámbar si no. El nivel de
  // confianza (alta / media / baja) sigue arriba, junto a quién dio la señal, pero ya no es el criterio:
  // medido en 164 operaciones, no separaba las ganadoras de las perdedoras.
  const showing = !waiting && !resting && !analyzing;
  // "MARTIN SUBE ▲" lleva la letra un poco menor para caber en una línea.
  $('signal-label').classList.toggle('martin', (showing && Boolean(s.signal && s.signal.source === 'martingala')) || (analyzing && !(s.newCandle && s.clockKnown)));
  const pat = showing ? s.pattern : null;
  const pct = $('signal-pct');
  const note = $('signal-pct-note');
  note.classList.toggle('hidden', !pat);
  if (pat) {
    // Con menos de 10 operaciones medidas el porcentaje no dice nada (2 de 2 sería "100 %"): no se muestra.
    const enough = pat.accuracy !== null && pat.decided >= 10;
    pct.className = !enough ? '' : pat.accuracy >= pat.breakEven ? 'good' : 'bad';
    pct.textContent = enough ? `${Math.round(pat.accuracy)} %` : '— %';
    const money = `${pat.pnl > 0 ? '+' : ''}${pat.pnl.toFixed(2)}`;
    let text = pat.decided
      ? `${pat.text} · ${pat.decided} op. · P&L ${money}${pat.decided < 10 ? ' · aún pocas para medir' : pat.decided < 20 ? ' · pocas' : ` · mín. ${pat.breakEven} %`}`
      : `${pat.text} · aún sin operaciones medidas`;
    if (pat.vetoed) text += ' · DESACTIVADO por estadística';
    note.textContent = text;
    note.title = pat.detail || '';
  } else pct.className = 'hidden';
  // Entrada sugerida: dónde esperar el precio y si ya llegó a la línea.
  const plan = showing && dir ? s.entry : null;
  $('signal-entry').classList.toggle('hidden', !plan);
  if (plan) {
    $('signal-entry').classList.toggle('taken', plan.zone ? plan.inZone !== false : plan.filled);
    if (plan.zone) $('signal-entry').textContent = plan.inZone === false ? 'precio FUERA de la zona de entrada' : 'precio DENTRO de la zona de entrada';
    else $('signal-entry').textContent = plan.filled ? `✔ entrada tomada en la línea (${plan.kind})` : `espera el precio en la línea · ${plan.kind}`;
  }
  // Seguimiento: cómo va la señal en este instante y, si va perdiendo al final, la martingala que viene.
  const follow = showing && dir ? s.follow : null;
  const line = $('signal-follow');
  const awaiting = showing && dir ? s.entryWait : null;
  line.classList.toggle('hidden', !awaiting && (!follow || !follow.state));
  if (awaiting) {
    line.className = 'entry';
    const byBot = s.bot && s.bot.order && s.bot.order.state === 'sending';
    line.textContent = byBot ? 'EL BOT ESTÁ ENTRANDO…' : `ESPERANDO TU ENTRADA · ${Math.ceil(awaiting.leftMs / 1000)} s`;
  } else if (follow && follow.state) {
    if (follow.next) {
      line.className = 'alert';
      // (El lado de la martingala sale de su propio análisis, al perder: aquí solo se avisa que viene.)
      line.textContent = `VA PERDIENDO · viene MARTINGALA ${follow.next.level}`;
    } else {
      line.className = follow.state === 'ganando' ? 'win' : follow.state === 'perdiendo' ? 'lose' : '';
      line.textContent = follow.state === 'ganando' ? 'va ganando' : follow.state === 'perdiendo' ? 'va perdiendo' : 'va igual';
    }
  }
  renderProgress(s);

  // --- Lecturas ---
  // Las 8 lecturas, en vivo. Si un momento no se pueden calcular, se conservan las últimas.
  if (s.panel) lastReadings = s.panel;
  if (lastReadings) {
    for (const reading of lastReadings) if (READING_KEYS.includes(reading.key)) setChip(reading);
  }
  $('readings-count').textContent = s.historyCandles ? `${s.historyCandles} velas` : '';
  // Con el eje de precios a la vista se muestra la cotización leída (y las distancias van en pips).
  $('readings-title').textContent = s.price ? `Precio ${s.price}` : s.pips ? 'Lecturas · en pips' : 'Lecturas · de la pantalla';
  $('readings-title').title = s.price
    ? 'Cotización leída del eje de precios de la gráfica.'
    : 'Para ver el precio y los pips, incluye en la zona los números del eje (a la derecha de la gráfica).';
  $('readings').classList.toggle('hidden', s.cycleSeconds === 0);
  $('readings-head').classList.toggle('hidden', s.cycleSeconds === 0);

  // --- Patrón medido en el precio real ---
  $('regime').classList.toggle('hidden', !s.regime);
  if (s.regime) {
    $('regime').textContent = `Patrón medido: ${s.regime.text}`;
    $('regime').classList.toggle('found', Boolean(s.regime.kind));
  }

  // --- Memoria del mercado ---
  $('memory').classList.toggle('hidden', !s.memory);
  if (s.memory) {
    $('memory').textContent = `Memoria (${s.memory.total} velas): ${s.memory.text}`;
    $('memory').classList.toggle('found', s.memory.votes);
  }

  // --- Salud de los datos: fuente activa (INTERNA / PÍXELES), edad del último dato y aviso ---
  const src = s.source;
  const chip = $('source-chip');
  chip.classList.toggle('hidden', !src || s.cycleSeconds === 0);
  if (src) {
    const internal = src.active === 'INTERNA';
    let text = `Fuente: ${src.active}`;
    if (internal) text += ` · ${src.ageSeconds === null ? '—' : src.ageSeconds.toFixed(1)} s`;
    else if (s.internalSource) {
      // En corto (el detalle completo va en la ayuda al pasar el ratón).
      const SHORT = { 'otro-par': 'interna en otro par', 'no-cuadra': /no coincide/.test(src.detail) ? 'interna no coincide: ¿otro par? ponlo en Activo (⚙)' : 'interna en espera', 'pocas-velas': 'interna con pocas velas' };
      text += src.warn ? ` · interna sin datos${src.ageSeconds !== null ? ` hace ${Math.round(src.ageSeconds)} s` : ''}` : ` · ${SHORT[src.code] || src.detail}`;
    }
    if (s.payoutNow) text += ` · pago ${s.payoutNow.value} %${s.payoutNow.source === 'interna' ? ' (demo)' : ''}`;
    chip.textContent = text;
    chip.className = internal ? 'internal' : s.internalSource && (src.warn || src.code === 'otro-par' || src.code === 'no-cuadra') ? 'warn' : '';
    chip.title = internal
      ? `Precios y velas leídos de los datos internos de la terminal demo (${src.detail}). Edad del último dato: ${src.ageSeconds === null ? '—' : src.ageSeconds.toFixed(1)} s.`
      : s.internalSource
        ? `Leyendo los píxeles de la pantalla porque ${src.detail}.`
        : 'Leyendo los píxeles de la pantalla (la fuente interna está apagada en ⚙).';
  }

  // --- Bot en DEMO: disponible, en pausa (y por qué) o qué hizo con la orden de esta señal ---
  const botChip = $('bot-chip');
  const b = s.bot;
  // Solo se muestra si el bot está abierto (o si acaba de fallar una orden): sin bot, el panel es el de siempre.
  botChip.classList.toggle('hidden', !b || s.cycleSeconds === 0 || (!b.online && !(b.order && b.order.error)));
  if (b) {
    const money = b.balance === null ? '' : ` · saldo $${Number(b.balance).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    let text = `Bot DEMO${money}`;
    let cls = 'on';
    const o = b.order;
    if (b.hold && !o) {
      text = 'Bot DEMO · automático en espera: pon a la vista la gráfica del par';
      cls = 'warn';
    } else if (o && o.state === 'sending') text = 'Bot DEMO · abriendo la operación…';
    else if (o && (o.state === 'open' || o.state === 'done')) text = `Bot DEMO · entró con $${Number(o.amount).toFixed(2)} · paga ${o.payout} %${o.level ? ` · martingala ${o.level}` : ''}`;
    else if (o && o.error) {
      text = `Bot DEMO · no entró: ${o.error}`;
      cls = 'warn';
    } else if (b.pause) {
      text = `Bot DEMO en pausa · ${b.pause}`;
      cls = b.enabled ? 'warn' : '';
    }
    botChip.textContent = text;
    botChip.className = cls;
    botChip.title = 'Bot de Pocket en la cuenta DEMO (trader\\pocket_tyl\\lector.py). Abre la operación de cada señal y de su martingala; el panel cuenta desde esa entrada y usa el resultado de Pocket.';
  }

  // --- Estadística por patrón y lo medido del veto anti-rebote (en el detalle) ---
  const table = $('pattern-table');
  const rows = s.patterns || [];
  table.classList.toggle('hidden', rows.length === 0 || s.cycleSeconds === 0);
  if (rows.length) {
    table.textContent = '';
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = row.off ? 'off' : row.accuracy !== null && row.decided >= 20 && row.accuracy >= row.breakEven ? 'good' : '';
      const money = `${row.pnl > 0 ? '+' : ''}${row.pnl.toFixed(2)}`;
      line.textContent = `${row.off ? '✕ ' : ''}${row.text}: ${row.accuracy === null ? '—' : `${Math.round(row.accuracy)} %`} · ${row.decided} op. · ${money}`;
      table.appendChild(line);
    }
  }
  const mt = s.martin || { wins: 0, losses: 0, ties: 0 };
  $('martin-line').classList.toggle('hidden', mt.wins + mt.losses + mt.ties === 0);
  $('martin-line').textContent = `Martingalas: ganaron ${mt.wins}, perdieron ${mt.losses}${mt.ties ? `, empates ${mt.ties}` : ''}`;
  const rb = s.rebound || { wins: 0, losses: 0, ties: 0 };
  const blocked = rb.wins + rb.losses + rb.ties;
  $('rebound-line').classList.toggle('hidden', blocked === 0);
  if (blocked) $('rebound-line').textContent = `Anti-rebote: bloqueó ${blocked} · habrían ganado ${rb.wins}, perdido ${rb.losses}`;
  const cc = s.candleCheck || { wins: 0, losses: 0, ties: 0 };
  const held = cc.wins + cc.losses + cc.ties;
  $('candle-line').classList.toggle('hidden', held === 0);
  if (held) $('candle-line').textContent = `Vela que cambió de color: frenó ${held} · habrían ganado ${cc.wins}, perdido ${cc.losses}`;

  // --- Aviso si algo impide leer la gráfica ---
  const problem = !/^Leyendo /.test(s.status);
  $('problem').classList.toggle('hidden', !problem);
  $('problem').textContent = s.status;

  // --- Contador: operaciones que marcó la plataforma (globo verde / rojo) ---
  const t = s.trades;
  const n = t.wins + t.losses;
  $('tr-wins').textContent = t.wins;
  $('tr-losses').textContent = t.losses;
  // Empates (globo amarillo): se muestran aparte y no entran en el porcentaje.
  $('tr-ties').textContent = t.ties || 0;
  $('tr-ties').classList.toggle('hidden', !t.ties);
  $('tr-bar').style.width = n ? `${(t.wins / n) * 100}%` : '0';
  $('tr-bar').parentElement.classList.toggle('empty', n === 0);
  const rate = $('tr-rate');
  if (n === 0) {
    rate.className = '';
    rate.textContent = t.ties ? `${t.ties} ${t.ties === 1 ? 'empate' : 'empates'} · mín. ${t.breakEven} %` : `Sin operaciones · mín. ${t.breakEven} %`;
  } else {
    rate.textContent = `${t.hitRate} % (${t.wins}/${n})${t.ties ? ` · ${t.ties} ${t.ties === 1 ? 'empate' : 'empates'}` : ''} · mín. ${t.breakEven} %`;
    // Rojo: por debajo del mínimo. Amarillo: arriba pero puede ser suerte. Verde: arriba con margen.
    rate.className = t.hitRate < t.breakEven ? 'bad' : /suerte|todavía/.test(t.verdict) ? 'unsure' : 'good';
  }
  rate.title = n ? t.verdict.replace(/señales medidas/, 'operaciones').replace(/señales/g, 'operaciones') : '';

  // La señal medida con el precio (operes o no), en una línea.
  const m = s.live.wins + s.live.losses;
  // Si ya se midió cuánto tarda el usuario en entrar, la señal se mide desde ese momento.
  const measured = s.entryDelay > 0 ? `Señal medida entrando a los ${s.entryDelay} s` : 'Señal medida con el precio';
  $('sc-line').textContent = m ? `${measured}: ${s.live.wins} de ${m} (${s.live.hitRate} %)` : `${measured}: aún sin datos`;
  $('sc-line').title = s.live.verdict + (s.lastResult ? ` Última señal: ${s.lastResult}.` : '');

  // Sobre la gráfica: el marcador de la vela actual y los niveles van siempre que el panel está
  // leyendo; el haz y el recuadro de cada vela, solo mientras se analiza.
  $('scan').classList.toggle('hidden', !s.scan);
  if (s.scan) renderScan(s);
  else scanShown = 0;

  // Costo aproximado por predicción de cada IA y cuánto tarda.
  const money = (v) => (v < 0.01 ? `${(v * 100).toFixed(2)} ¢` : `$${v.toFixed(3)}`);
  const costs = AI_BLOCKS.map((block) => ({ name: s.ai.names[s.ai.ids.indexOf(block.provider)], info: s.providers[block.provider] }))
    .filter((c) => c.info.enabled && c.info.usage.calls > 0)
    .map((c) => {
      const each = c.info.usage.priced ? money(c.info.usage.cost / c.info.usage.calls) : `${Math.round((c.info.usage.input + c.info.usage.output) / c.info.usage.calls)} tokens`;
      return `${c.name} ${each}${c.info.seconds ? ` (${c.info.seconds} s)` : ''}`;
    });
  $('ai-cost').classList.toggle('hidden', costs.length === 0);
  $('ai-cost').textContent = costs.length ? `Por predicción: ${costs.join(' · ')}` : '';

  // Marcador de cada IA por separado.
  const scores = (s.aiScores || []).filter((a) => a.wins + a.losses > 0);
  $('ai-scores').classList.toggle('hidden', scores.length === 0);
  $('ai-scores').textContent = scores.map((a) => `${a.name} ${a.wins}/${a.wins + a.losses}`).join(' · ');

  // Comparación: la señal de las reglas dada al instante de pulsar (solo si la mostrada es otra).
  const fast = s.instantScore;
  const fastCount = fast ? fast.wins + fast.losses : 0;
  const showFast = Boolean(fast) && fastCount > 0 && !s.instant && s.ai.enabled;
  $('sc-instant').classList.toggle('hidden', !showFast);
  if (showFast) $('sc-instant').textContent = `Reglas al instante: ${fast.wins} de ${fastCount} (${fast.hitRate} %)`;

  // --- Zona ---
  const zone = $('zone');
  if (s.region) {
    place(zone, s.region);
    zone.classList.remove('hidden');
  } else {
    zone.classList.add('hidden');
  }

  // --- Ajustes ---
  $('btn-auto').textContent = `Escáner: ${s.auto ? 'ON' : 'OFF'}`;
  $('btn-auto').classList.toggle('on', s.auto);
  if (document.activeElement !== $('payout')) $('payout').value = s.payout;
  if (document.activeElement !== $('cycle')) $('cycle').value = s.cycleSeconds;
  if (document.activeElement !== $('pause')) $('pause').value = s.pauseSeconds;
  $('always').checked = s.alwaysSignal;
  if (document.activeElement !== $('martin')) $('martin').value = s.martinLevels === undefined ? 4 : s.martinLevels;
  if (document.activeElement !== $('entry-wait')) $('entry-wait').value = s.entryWaitSeconds === undefined ? 5 : s.entryWaitSeconds;
  $('auto-trade').checked = !s.bot || s.bot.enabled !== false;
  $('new-candle').checked = s.newCandle !== false;
  $('pattern-veto').checked = s.patternVeto !== false;
  $('anti-rebound').checked = s.antiRebound !== false;
  $('internal-source').checked = s.internalSource !== false;
  $('btn-visor').disabled = s.internalSource === false;
  $('auto-mode').checked = !s.manual;
  $('instant').checked = s.instant;
  $('instant').disabled = !s.manual; // solo aplica con el botón
  if (document.activeElement !== $('asset')) $('asset').value = s.asset;
  for (const block of AI_BLOCKS) renderAiBlock(block, s.providers[block.provider]);
  $('status').textContent = s.status;
});

api.ready();
