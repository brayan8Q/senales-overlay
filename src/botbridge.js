/**
 * PUENTE AL BOT DE POCKET (15 nov 2026).
 *
 * El panel decide; el bot (proceso aparte, trader\pocket_tyl\lector.py) abre la operación en la
 * cuenta DEMO de Pocket Option y contesta con los datos de la propia plataforma: precio y hora de
 * la entrada, pago, y después el resultado. Así el plazo se cuenta desde la entrada exacta y no
 * hay que adivinarla en la pantalla.
 *
 * El bot deja una tarjeta (lector.json: puerto y clave) en su carpeta de datos mientras está
 * abierto; sin tarjeta, el panel sigue como siempre (entrada a mano). Solo se habla con
 * 127.0.0.1, y solo se usa si el bot dice que su cuenta es DEMO.
 *
 * En las pruebas (node --test) nunca se habla con un bot de verdad, salvo que se dé una carpeta.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const OFFLINE = { online: false, connected: false, demo: null, balance: null, stake: null, factor: null, levels: null, error: '' };

/** Una petición al bot. Devuelve el JSON de la respuesta. */
function httpRequest({ port, token, method, target, body = null, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers: { 'X-Lector-Token': token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('el bot contestó algo que no se entiende'));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('el bot no contestó a tiempo')));
    req.on('error', (err) => reject(err));
    if (data) req.write(data);
    req.end();
  });
}

function createBotBridge({ dir = null, request = httpRequest } = {}) {
  const testing = Boolean(process.env.NODE_TEST_CONTEXT) || Boolean(require.main && /\.test\.js$/.test(require.main.filename || ''));
  const disabled = !dir && testing;
  const folder = dir || path.join(process.env.LOCALAPPDATA || '.', 'PocketTyl');
  let card = null;
  let state = { ...OFFLINE };

  const readCard = () => {
    try {
      const found = JSON.parse(fs.readFileSync(path.join(folder, 'lector.json'), 'utf8'));
      card = Number.isFinite(found.port) && typeof found.token === 'string' ? found : null;
    } catch {
      card = null; // el bot no está abierto
    }
  };
  const call = (method, target, body, timeoutMs) => {
    if (disabled || !card) return Promise.reject(new Error('el bot no está abierto'));
    return request({ port: card.port, token: card.token, method, target, body, timeoutMs });
  };

  return {
    /** Pregunta al bot cómo está (se llama cada pocos segundos). */
    async refresh() {
      if (disabled) return state;
      readCard();
      if (!card) {
        state = { ...OFFLINE };
        return state;
      }
      try {
        const s = await call('GET', '/estado', null, 1500);
        state = {
          // Solo cuenta como disponible si está conectado a Pocket Y su cuenta es la DEMO.
          online: Boolean(s && s.ok && s.connected && s.demo === true),
          connected: Boolean(s && s.connected),
          demo: s ? s.demo : null,
          balance: s && Number.isFinite(s.balance) ? s.balance : null,
          stake: s ? s.stake : null,
          factor: s ? s.factor : null,
          levels: s ? s.levels : null,
          error: s && s.ok ? '' : (s && s.error) || 'el bot no contestó bien',
        };
      } catch (err) {
        state = { ...OFFLINE, error: err.message };
      }
      return state;
    },
    status: () => state,
    /** Abre una operación: { asset, dir: 'up'|'down', seconds, level }. */
    order: (payload) => call('POST', '/orden', payload, 9500),
    /** Espera el resultado que da Pocket de esa operación. */
    result: (id, seconds) => call('GET', `/resultado?id=${encodeURIComponent(id)}`, null, (Number(seconds) + 25) * 1000),
  };
}

module.exports = { createBotBridge, httpRequest };
