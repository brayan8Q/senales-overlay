const test = require('node:test');
const assert = require('node:assert/strict');
const { createCandleClock, periodOf, GRACE_MS } = require('../src/candleclock');

test('sin haber visto cerrar ninguna vela el reloj no se inventa', () => {
  const clock = createCandleClock();
  const c = clock.update({ now: 1000, closed: false, seconds: 15 });
  assert.equal(c.known, false);
  assert.equal(c.elapsedMs, null);
  assert.equal(c.remainingMs, null);
  assert.equal(c.closedNow, false);
});

test('al ver cerrar una vela se pone en hora: lo que lleva y lo que le falta', () => {
  const clock = createCandleClock();
  let c = clock.update({ now: 10000, closed: true, seconds: 15 });
  assert.equal(c.closedNow, true);
  assert.equal(c.inferred, false);
  assert.equal(c.known, true);
  assert.equal(c.elapsedMs, 0);
  assert.equal(c.remainingMs, 15000);
  c = clock.update({ now: 17000, closed: false, seconds: 15 });
  assert.equal(c.closedNow, false);
  assert.equal(c.elapsedMs, 7000);
  assert.equal(c.remainingMs, 8000);
});

test('si llega la hora y la grafica estaba tapada, el cierre se da por el reloj (una sola vez)', () => {
  const clock = createCandleClock();
  clock.update({ now: 10000, closed: true, seconds: 15 });
  // Justo antes del margen todavia se espera a verlo.
  let c = clock.update({ now: 25000 + GRACE_MS - 1, closed: false, seconds: 15 });
  assert.equal(c.closedNow, false);
  assert.equal(c.remainingMs, 0);
  c = clock.update({ now: 25000 + GRACE_MS, closed: false, seconds: 15 });
  assert.equal(c.closedNow, true);
  assert.equal(c.inferred, true);
  assert.equal(c.startedAt, 25000); // la vela nueva abrio a su hora, no cuando se dio por cerrada
  // La grafica se destapa y el panel "ve" ese mismo cierre con retraso: no se cuenta dos veces.
  c = clock.update({ now: 27500, closed: true, seconds: 15 });
  assert.equal(c.closedNow, false);
  assert.equal(c.startedAt, 25000);
  // El siguiente cierre, visto a su hora, si cuenta.
  c = clock.update({ now: 40200, closed: true, seconds: 15 });
  assert.equal(c.closedNow, true);
  assert.equal(c.startedAt, 40200);
});

test('mide la duracion de la vela con dos intervalos iguales si nadie se la dice', () => {
  assert.equal(periodOf(15200), 15);
  assert.equal(periodOf(59000), 60);
  assert.equal(periodOf(22000), 0);
  const clock = createCandleClock();
  let c = clock.update({ now: 1000, closed: true });
  assert.equal(c.known, false); // se sabe cuando abrio, pero no cuanto dura
  assert.equal(c.elapsedMs, 0);
  c = clock.update({ now: 16100, closed: true });
  assert.equal(c.known, false);
  c = clock.update({ now: 31050, closed: true });
  assert.equal(c.known, true);
  assert.equal(c.seconds, 15);
  assert.equal(c.remainingMs, 15000);
});

test('tras varios cierres seguidos sin ver la grafica, el reloj se declara desconocido', () => {
  const clock = createCandleClock();
  clock.update({ now: 1000, closed: true, seconds: 15 });
  let closes = 0;
  let c = null;
  for (let now = 1300; now <= 81000; now += 300) {
    c = clock.update({ now, closed: false, seconds: 15 });
    if (c.closedNow) closes++;
  }
  assert.equal(closes, 3); // tres por reloj y ni uno mas
  assert.equal(c.known, false);
  // Al volver a ver un cierre, se pone en hora de nuevo.
  c = clock.update({ now: 91000, closed: true, seconds: 15 });
  assert.equal(c.known, true);
  assert.equal(c.closedNow, true);
});

test('reset lo deja como recien abierto', () => {
  const clock = createCandleClock();
  clock.update({ now: 1000, closed: true, seconds: 15 });
  clock.reset();
  assert.equal(clock.update({ now: 5000, closed: false, seconds: 15 }).known, false);
});
