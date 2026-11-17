// Solo para probar el dibujo de las 4 gráficas con datos de ejemplo (renderer/wall_demo.html). No lo usa el panel.
(function () {
  let feed = null;
  window.senales = { onWall: (cb) => { feed = cb; }, wallReady: () => {} };
  const make = (start, step, n, seed) => {
    const out = [];
    let p = start;
    let s = seed;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < n; i++) {
      const open = p;
      const close = p + (rnd() - 0.48) * step * 2;
      out.push({ open, close, high: Math.max(open, close) + rnd() * step * 0.6, low: Math.min(open, close) - rnd() * step * 0.6 });
      p = close;
    }
    return out;
  };
  window.addEventListener('load', () => {
    const now = Date.now();
    const a = make(1.12603, 0.00012, 65, 7);
    const b = make(186.483, 0.03, 65, 11);
    const c = make(47.50852, 0.0004, 65, 23);
    const d = make(0.9121, 0.00009, 65, 5);
    const slot = (name, list, extra) => ({ name, payout: 92, found: true, ready: true, dir: 'up', margin: 5, pattern: 'tendencia', why: '', rest: 0, openFor: 7.4, closed: list.slice(0, -1), forming: list[list.length - 1], order: null, last: null, trades: [], ...extra });
    const state = {
      on: true, why: '', pick: 'USD/EGP OTC', minMargin: 5,
      rules: '5+ lecturas de ventaja · tendencia o rompimiento · vela de 5 a 11 s · vela de su color',
      tally: { wins: 12, losses: 7, ties: 1, net: 4.04, series: 0, lost: 0 },
      slots: [
        slot('EUR/USD OTC', a, { order: { name: 'EUR/USD OTC', dir: 'up', level: 0, amount: 1, openPrice: a[64].open, openedAt: now - 1500 }, trades: [{ name: 'EUR/USD OTC', dir: 'down', result: 'loss', openPrice: a[50].close, openedAt: now - 7400 - 14 * 15000 + 4000 }, { name: 'EUR/USD OTC', dir: 'up', result: 'win', openPrice: a[58].open, openedAt: now - 7400 - 6 * 15000 + 6000 }] }),
        slot('CHF/JPY OTC', b, { dir: 'down', margin: 2, pattern: 'rango', why: 'ventaja 2 (entra con 5)' }),
        slot('USD/EGP OTC', c, { last: { name: 'USD/EGP OTC', dir: 'up', result: 'win', net: 0.92, at: now } }),
        slot('EUR/CHF OTC', d, { dir: 'down', margin: 5, pattern: 'tendencia', why: 'la vela acaba de abrir (va en 2 s): espero a ver hacia dónde va', openFor: 2.1, rest: 0 }),
      ],
    };
    if (feed) feed(state);
  });
})();
