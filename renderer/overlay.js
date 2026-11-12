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
}
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
  for (const [id, row] of [['scan-support', scan.support], ['scan-resistance', scan.resistance]]) {
    $(id).classList.toggle('hidden', row === null);
    if (row !== null) $(id).style.top = `${row}px`;
  }
  $('scan').classList.toggle('signal', scan.mode === 'signal');
  renderCurrentCandle(scan.current);
  renderEntry(scan);
  const state = scan.verified ? 'lectura verificada ✓' : 'verificando lectura…';
  const saved = scan.saved ? ` · ${scan.saved} en memoria` : '';
  const rate = scan.rate ? ` · ${scan.rate} lecturas/s` : '';
  $('scan-label').textContent =
    scan.mode === 'signal'
      ? `SIGUIENDO LA VELA ACTUAL · ${state}${rate}`
      : `ESCANEANDO · ${scan.candles.length} velas${saved} · ${state}${rate}${who}`;
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
  const ids = ['scan-body', 'scan-wick', 'scan-high', 'scan-low', 'scan-open', 'scan-now', 'scan-info', 'scan-clock'];
  if (!c) {
    for (const id of ids) $(id).classList.add('hidden');
    return;
  }
  const pips = (v) => (v === null ? '' : `${v} pips`);
  const center = c.x + c.w / 2;
  // Cuerpo: recuadro justo sobre sus bordes (mínimo 3 px de alto para que se vea en una vela plana).
  const bodyHeight = Math.max(3, c.bodyBottom - c.bodyTop);
  placeScan('scan-body', { left: c.x - 1, width: c.w + 2, top: c.bodyTop - 1, height: bodyHeight + 2 }).classList.toggle('covered', c.covered);
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
  info.textContent = c.covered ? 'vela actual tapada: última lectura buena' : `vela actual: ${c.pattern || (c.up ? 'verde' : 'roja')}${body}${figure}`;
  // Reloj de la vela: cuánto lleva de lo que dura.
  if (c.seconds && c.elapsed !== null) {
    const clock = placeScan('scan-clock', { left: c.x - 1, width: c.w + 2, top: c.low + 8 });
    clock.querySelector('i').style.width = `${Math.min(100, (100 * c.elapsed) / c.seconds)}%`;
    clock.title = `${Math.min(c.elapsed, c.seconds).toFixed(0)} s de ${c.seconds}`;
  } else $('scan-clock').classList.add('hidden');
}

/** Durante la señal: línea en el precio de entrada y cuántos pips va a favor o en contra. */
function renderEntry(scan) {
  const el = $('scan-entry');
  const target = $('scan-target');
  if (scan.mode !== 'signal' || !scan.entry) {
    el.classList.add('hidden');
    target.classList.add('hidden');
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
  let text = sell ? 'VENTA ▼ sugerida' : 'COMPRA ▲ sugerida';
  if (e.quote) text += ` · ${e.quote}`;
  if (e.confidence === 'baja') text += ' · confianza baja';
  if (e.pips !== null) text += e.pips > 0 ? ` · va ganando +${e.pips} pips` : e.pips < 0 ? ` · va perdiendo ${e.pips} pips` : ' · va igual';
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

/** Barra: durante el análisis avanza por pasos; durante la señal se vacía hasta calificarla. */
function renderProgress(s) {
  const bar = $('progress');
  const timed = s.cycleSeconds > 0;
  if (!timed || (s.phase !== 'analysis' && s.phase !== 'signal')) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  if (s.phase === 'analysis') {
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
  } else {
    const total = Math.max(1, s.cycleSeconds * 1000);
    bar.className = 'signal';
    $('progress-fill').style.width = `${Math.round(Math.min(1, s.remainingMs / total) * 100)}%`;
    $('progress-text').textContent = `Se califica en ${Math.ceil(s.remainingMs / 1000)} s`;
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
  const manual = s.manual && s.cycleSeconds > 0;
  const resting = manual && s.phase === 'idle'; // modo manual, esperando a que pulsen PREDECIR

  // Botón PREDECIR: activo solo cuando hay gráfica y no hay una predicción en curso.
  const predict = $('btn-predict');
  predict.classList.toggle('hidden', !manual);
  predict.disabled = !(resting && s.ready);
  predict.textContent = analyzing ? 'Analizando…' : s.phase === 'signal' ? 'Señal en curso' : 'PREDECIR';

  if (resting) {
    $('signal').className = 'wait';
    $('signal-label').textContent = 'LISTO';
    $('signal-detail').textContent = s.lastResult
      ? `La última señal ${s.lastResult}. Pulsa PREDECIR para otra.`
      : 'Pulsa PREDECIR para pedir una señal.';
    $('signal-source').textContent = '';
  } else if (analyzing) {
    $('signal').className = 'analysis';
    $('signal-label').textContent = 'ANALIZANDO';
    $('signal-detail').textContent = s.ai.enabled ? 'Leyendo las velas y consultando a la IA.' : 'Leyendo las velas y el movimiento del precio.';
    $('signal-source').textContent = '';
  } else {
    // Una señal de confianza baja se ve rayada: el panel eligió un lado sin lectura clara.
    const low = Boolean(dir) && s.signal.confidence === 'baja';
    $('signal').className = (dir || 'wait') + (low ? ' low' : '');
    $('signal-label').textContent = SIGNAL_TEXT[dir] || 'ESPERAR';
    $('signal-detail').textContent = s.signal ? s.signal.reason : '';
    $('signal-detail').title = s.signal ? s.signal.reason : '';
    let source = s.signal && s.signal.source ? (s.signal.source === 'ia' ? 'IA' : 'reglas') : '';
    if (source && dir && s.signal.confidence) source += ` · ${s.signal.confidence}`;
    $('signal-source').textContent = source;
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

  // Escáner sobre la gráfica mientras se analiza.
  $('scan').classList.toggle('hidden', !s.scanning);
  if (s.scanning) renderScan(s);
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
  $('auto-mode').checked = !s.manual;
  $('instant').checked = s.instant;
  $('instant').disabled = !s.manual; // solo aplica con el botón
  if (document.activeElement !== $('asset')) $('asset').value = s.asset;
  for (const block of AI_BLOCKS) renderAiBlock(block, s.providers[block.provider]);
  $('status').textContent = s.status;
});

api.ready();
