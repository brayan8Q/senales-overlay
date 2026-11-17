/**
 * LAS 4 GRÁFICAS DEL PANEL (16 nov 2026).
 *
 * El usuario: «tú puedes estarle cambiando las divisas y arreglar siempre a S15 y M10… haz todo para que no deje de
 * funcionar». Nadie puede hacer clic en su pestaña de Pocket, y los pagos cambian en minutos. Solucion: el panel
 * abre su PROPIA ventana con cuatro graficas de la terminal de prueba publica de Pocket Option (sin cuenta ni
 * contraseña; son las mismas graficas OTC) y las maneja el: el par de cada una (el de su lugar en «varios pares»),
 * velas de 15 s, vista M10, sin botones de compra/venta ni menus, y la zona del escaner de cada una puesta sola.
 *
 * Aqui va lo que no depende de Electron: nombres de simbolo, reparto de la ventana, la zona de cada grafica y los
 * guiones que se corren dentro de la pagina. Las operaciones del bot NO salen en estas graficas (son de otra sesion):
 * las marca el panel encima (letrero amarillo «EL BOT ENTRÓ», verde/rojo al cerrar).
 */
const URL = 'https://pocketoption.com/en/cabinet/try-demo/';
const GAP = 4; // separacion entre graficas
// Margenes de la zona dentro del lienzo de la grafica: arriba quedan el nombre del par y sus banderas (tienen rojo y
// verde: el lector las tomaria por velas), a la derecha el eje de precios y abajo el eje de tiempo.
const ZONE = { top: 46, right: 88, bottom: 34, left: 2 };

/** «EUR/USD OTC» → «EURUSD_otc» (asi se llama el par dentro de la terminal). */
function symbolOf(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const otc = /\botc$/i.test(text);
  const base = text.replace(/\s*otc$/i, '').replace(/[^A-Za-z0-9#-]/g, '');
  return base ? base.toUpperCase() + (otc ? '_otc' : '') : '';
}

// La terminal de Pocket no se encoge por debajo de este tamaño (medido: en un recuadro chico la grafica se salia
// por abajo). Cada grafica se muestra reducida lo justo para que la pagina crea que tiene al menos esto.
const PAGE_MIN = { width: 1150, height: 700 };
/** Cuanto hay que reducir la pagina para que quepa entera en un recuadro de ese tamaño. */
function zoomFor(bounds) {
  return Math.max(0.3, Math.min(1, bounds.width / PAGE_MIN.width, bounds.height / PAGE_MIN.height));
}

/** Cuatro recuadros (2 × 2) dentro de una ventana de `width` × `height`. */
function gridBounds(width, height) {
  const w = Math.max(120, Math.floor((width - GAP) / 2));
  const h = Math.max(90, Math.floor((height - GAP) / 2));
  return [
    { x: 0, y: 0, width: w, height: h },
    { x: w + GAP, y: 0, width: width - w - GAP, height: h },
    { x: 0, y: h + GAP, width: w, height: height - h - GAP },
    { x: w + GAP, y: h + GAP, width: width - w - GAP, height: height - h - GAP },
  ];
}

/**
 * La zona de pantalla donde estan las velas de una grafica.
 * @param {{x:number,y:number}} content esquina del contenido de la ventana, en la pantalla
 * @param {{x:number,y:number}} view esquina de la grafica dentro de la ventana
 * @param {number[]} canvas [x, y, ancho, alto] del lienzo dentro de la pagina
 */
function zoneOf(content, view, canvas, zoom = 1) {
  if (!canvas || canvas.length < 4) return null;
  // La pagina se ve reducida (`zoom`): sus medidas se pasan a puntos de pantalla.
  const [cx, cy, cw, ch] = canvas.map((v) => v * zoom);
  const m = { top: ZONE.top * zoom, right: ZONE.right * zoom, bottom: ZONE.bottom * zoom, left: ZONE.left * zoom };
  const zone = {
    x: Math.round(content.x + view.x + cx + m.left),
    y: Math.round(content.y + view.y + cy + m.top),
    width: Math.round(cw - m.left - m.right),
    height: Math.round(ch - m.top - m.bottom),
  };
  return zone.width >= 60 && zone.height >= 40 ? zone : null;
}

// Lo que se oculta de la terminal: cabecera, menus laterales, el panel de compra/venta y la lista de operaciones.
const CLEAN_CSS = `
.wrapper__top, .left-sidebar, .right-sidebar, .control-wrap, .tutorial-v1, .right-widget-container, .deals-list,
.widget-slot, .scroll-to-end { display: none !important; }
.chart-container { right: 0 !important; }
`;

/**
 * Guion que se corre DENTRO de la pagina: la deja limpia, en velas de 15 s y vista M10, y devuelve que par muestra
 * y donde esta el lienzo. Se puede correr las veces que haga falta (si ya esta todo, no toca nada).
 */
const SETUP_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s, root = document) => Array.from(root.querySelectorAll(s));
  if (!document.getElementById('lector-limpio')) {
    const st = document.createElement('style');
    st.id = 'lector-limpio';
    st.textContent = ${JSON.stringify(CLEAN_CSS)};
    document.head.appendChild(st);
    window.dispatchEvent(new Event('resize'));
    await sleep(400);
  }
  const exit = document.querySelector('.tutorial-v1__close-icon.js-exit');
  if (exit) exit.click();
  const button = document.querySelector('.items__link--chart-type');
  const canvas = document.querySelector('canvas.layer.plot');
  if (!button || !canvas) return { ok: false, why: 'la gráfica aún no carga' };
  const top = () => ((document.querySelector('.top-left-block') || {}).innerText || '').replace(/\\s+/g, ' ');
  let changed = false;
  if (!/\\bS15\\b/.test(top())) {
    const closeMenu = () => {
      const wrap = document.querySelector('.drop-down-modal-wrap');
      if (wrap) for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) wrap.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: innerWidth - 5, clientY: innerHeight - 5 }));
    };
    if (!document.querySelector('.drop-down-modal--chart-type')) { button.click(); await sleep(500); }
    let menu = document.querySelector('.drop-down-modal--chart-type');
    if (menu) {
      const candles = q('.chart-list-block li', menu).find((li) => /Candles|Velas/i.test(li.innerText));
      if (candles && !candles.classList.contains('active')) { (candles.querySelector('a') || candles).click(); await sleep(700); }
      menu = document.querySelector('.drop-down-modal--chart-type');
      const s15 = menu ? q('.time-frames-block li', menu).find((li) => li.innerText.trim() === 'S15') : null;
      if (s15 && !s15.classList.contains('active')) { (s15.querySelector('a') || s15).click(); await sleep(600); }
      closeMenu();
      await sleep(300);
      changed = true;
    }
  }
  const select = document.querySelector('.zoom-controls select');
  if (select) {
    const m10 = Array.from(select.options).find((o) => o.text.trim() === 'M10');
    if (m10 && select.value !== m10.value) { select.value = m10.value; select.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); changed = true; }
  }
  const box = canvas.getBoundingClientRect();
  const off = document.querySelector('.asset-inactive');
  return {
    ok: true,
    changed,
    symbol: localStorage.getItem('po-td-asset') || '',
    shown: ((document.querySelector('.current-symbol') || {}).innerText || '').trim(),
    s15: /\\bS15\\b/.test(top()),
    canvas: [box.x, box.y, box.width, box.height],
    inactive: Boolean(off && off.offsetParent !== null && getComputedStyle(off).visibility !== 'hidden' && (off.innerText || '').trim()),
  };
})()`;

/** Guion que cambia el par de la terminal (lo guarda donde ella lo lee y recarga). */
const switchScript = (symbol) => `localStorage.setItem('po-td-asset', ${JSON.stringify(symbol)}); location.reload();`;

module.exports = { URL, symbolOf, gridBounds, zoomFor, zoneOf, PAGE_MIN, SETUP_SCRIPT, switchScript, CLEAN_CSS, ZONE, GAP };
