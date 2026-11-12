/** Figuras de varias velas: doble techo/piso, estrellas y tres soldados/cuervos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { findFormation, flip } = require('../src/formations');
const { decide, createTimedTracker } = require('../src/timed');
const { describeChart, systemPrompt } = require('../src/ai');

/** Vela con apertura y cierre dados y mechas de 1 punto. */
const c = (open, close, up = 1, down = 1) => ({
  dir: close > open ? 'up' : close < open ? 'down' : 'flat',
  open,
  close,
  high: Math.max(open, close) + up,
  low: Math.min(open, close) - down,
});
/** Unas velas de lado para que haya con qué comparar tamaños (cuerpos de 4, rango ~6). */
const SIDEWAYS = [c(100, 104), c(104, 100), c(100, 104), c(104, 100), c(100, 104), c(104, 100)];

test('estrella de la tarde y estrella de la mañana', () => {
  // Verde grande, vela chiquita arriba, roja que cierra bajo la mitad de la primera
  const evening = [...SIDEWAYS, c(100, 108), c(108.5, 109), c(108.5, 102)];
  let f = findFormation(evening);
  assert.equal(f.name, 'estrella de la tarde');
  assert.equal(f.vote, -2);
  assert.equal(f.kind, 'reverse');
  assert.match(f.text, /giro hacia abajo/);
  // La misma gráfica volteada: estrella de la mañana, hacia arriba
  f = findFormation(flip(evening));
  assert.equal(f.name, 'estrella de la mañana');
  assert.equal(f.vote, 2);

  // No es estrella si la tercera vela no recupera la mitad de la primera...
  assert.equal(findFormation([...SIDEWAYS, c(100, 108), c(108.5, 109), c(108.5, 106)]), null);
  // ...ni si la de en medio es grande
  assert.equal(findFormation([...SIDEWAYS, c(100, 108), c(108, 112), c(112, 102)]), null);
});

test('tres soldados y tres cuervos', () => {
  const soldiers = [...SIDEWAYS, c(100, 103), c(103, 106.5), c(106.5, 110)];
  let f = findFormation(soldiers);
  assert.equal(f.name, 'tres soldados');
  assert.equal(f.vote, 1);
  assert.equal(f.kind, 'follow');
  f = findFormation(flip(soldiers));
  assert.equal(f.name, 'tres cuervos');
  assert.equal(f.vote, -1);
  // Tres verdes con cuerpos mínimos no cuentan
  assert.equal(findFormation([...SIDEWAYS, c(100, 100.5), c(100.5, 101), c(101, 101.5)]), null);
  // Ni si una no cierra más arriba que la anterior
  assert.equal(findFormation([...SIDEWAYS, c(100, 104), c(101, 103.5), c(103.5, 107)]), null);
});

test('doble techo y doble piso', () => {
  // Sube a 112, baja a 104, vuelve a 112 y se separa hacia abajo
  const top = [
    c(100, 103), c(103, 106), c(106, 109), c(109, 111), // primer techo: máximo 112
    c(111, 108), c(108, 105), c(105, 104.5), // baja (valle ~103.5)
    c(104.5, 108), c(108, 111), // segundo techo: máximo 112
    c(111, 108.5), c(108.5, 107), // ya girando
  ];
  let f = findFormation(top);
  assert.equal(f.name, 'doble techo');
  assert.equal(f.vote, -2);
  assert.equal(f.kind, 'reverse');
  f = findFormation(flip(top));
  assert.equal(f.name, 'doble piso');
  assert.equal(f.vote, 2);

  // Si rompe el techo hacia arriba, ya no es doble techo
  const broken = [...top.slice(0, 9), c(111, 114), c(114, 113)];
  assert.notEqual((findFormation(broken) || {}).name, 'doble techo');
  // Si el segundo máximo queda claramente más bajo, tampoco
  const lower = [...top.slice(0, 7), c(104.5, 107), c(107, 108.5), c(108.5, 106), c(106, 105)];
  assert.notEqual((findFormation(lower) || {}).name, 'doble techo');
});

test('sin figura: velas de lado, o muy pocas velas', () => {
  assert.equal(findFormation(SIDEWAYS), null);
  assert.equal(findFormation([c(100, 104), c(104, 100)]), null);
  assert.equal(findFormation([]), null);
});

test('la figura cuenta en la señal, según el patrón medido', () => {
  const side = { dir: null };
  const none = { vote: 0, text: 'sin fuerza' };
  const star = { name: 'estrella de la tarde', vote: -2, kind: 'reverse', text: 'estrella de la tarde (giro hacia abajo)' };
  const soldiers = { name: 'tres soldados', vote: 1, kind: 'follow', text: 'tres soldados (continuación hacia arriba)' };

  // Sin patrón medido: una figura de giro (2 votos) da señal por sí sola
  const d = decide(side, none, [], { formation: star });
  assert.equal(d.dir, 'down');
  assert.match(d.reason, /^Figura: estrella de la tarde \(giro hacia abajo\)/);
  // Tres soldados vale 1 voto: solo no alcanza, con un tramo a favor sí
  assert.equal(decide(side, none, [], { formation: soldiers }).dir, null);
  assert.equal(decide(side, none, ['up'], { formation: soldiers }).dir, 'up');

  // Si el precio viene CONTINUANDO, una figura de giro no cuenta; una de continuación sí
  const continues = { kind: 'continua', vote: 0, text: 'continúa 60 %' };
  assert.equal(decide(side, none, [], { formation: star, regime: continues }).dir, null);
  assert.equal(decide(side, none, ['up'], { formation: soldiers, regime: continues }).dir, 'up');
  // Si viene REBOTANDO, al revés
  const bounces = { kind: 'rebota', vote: 0, text: 'rebota 60 %' };
  assert.equal(decide(side, none, [], { formation: star, regime: bounces }).dir, 'down');
  assert.doesNotMatch(decide(side, none, [], { formation: soldiers, regime: bounces, force: true }).reason, /Figura:/);
});

test('el panel informa la figura y se le manda a las IA', () => {
  const evening = [...SIDEWAYS, c(100, 108), c(108.5, 109), c(108.5, 102), c(102, 101.5)]; // la última, en curso
  const t = createTimedTracker();
  const s = t.update({ candles: evening, priceY: -101.5, now: 0, cycleMs: 5000, payout: 85, manual: true });
  assert.equal(s.formation.name, 'estrella de la tarde');

  const snapshot = describeChart(evening, [], 5, { formation: s.formation });
  assert.deepEqual(
    { nombre: snapshot.figura_detectada.nombre, tipo: snapshot.figura_detectada.tipo, apunta: snapshot.figura_detectada.apunta },
    { nombre: 'estrella de la tarde', tipo: 'de giro', apunta: 'hacia abajo' },
  );
  assert.equal(describeChart(evening, [], 5).figura_detectada, undefined);
  assert.match(systemPrompt(true), /figura_detectada/);
});
