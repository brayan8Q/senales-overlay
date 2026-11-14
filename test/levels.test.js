const test = require('node:test');
const assert = require('node:assert/strict');
const { niveles, SIN_NIVEL } = require('../src/levels');

// Vela de prueba: [minimo, maximo, cierre]. Todas miden 10 de rango, asi la "vela tipica" es 10:
// agrupar < 2.5, margen de cruce 2.5, "pegado al precio" < 5, preferir hasta 10 mas lejos.
const vela = ([low, high, close]) => ({ open: (low + high) / 2, high, low, close, dir: close >= (low + high) / 2 ? 'up' : 'down' });
const velas = (filas, enCurso) => [...filas, enCurso].map(vela);

// Un piso en 100 (vela 3) y un techo en 150 (vela 8); el precio queda en medio.
const BASE = [
  [120, 130, 125],
  [115, 125, 118],
  [108, 118, 110],
  [100, 110, 108], // piso 100
  [106, 116, 114],
  [112, 122, 120],
  [120, 130, 128],
  [130, 140, 138],
  [140, 150, 142], // techo 150
  [134, 144, 136],
  [126, 136, 128],
  [122, 132, 126],
];

test('soporte y resistencia mas cercanos, vigentes, con sus toques', () => {
  const r = niveles(velas(BASE, [120, 130, 125]), 125);
  assert.equal(r.estado, 'ok');
  assert.equal(r.tipica, 10);
  assert.deepEqual(r.soporte, { precio: 100, toques: 1, invertido: false });
  assert.deepEqual(r.resistencia, { precio: 150, toques: 1, invertido: false });
});

test('con menos de 8 velas cerradas no se inventa nada: "sin nivel"', () => {
  const r = niveles(velas(BASE.slice(0, 7), [106, 116, 110]), 110);
  assert.equal(r.estado, SIN_NIVEL);
  assert.equal(r.estado, 'sin nivel');
  assert.equal(r.soporte, null);
  assert.equal(r.resistencia, null);
  // Con 8 ya se calcula (aunque no encuentre nivel de algun lado).
  assert.equal(niveles(velas(BASE.slice(0, 8), [134, 144, 140]), 140).estado, 'ok');
});

test('nivel ya roto (el precio lo cruzo dos veces despues del ultimo toque) se descarta', () => {
  const filas = [
    [120, 130, 125],
    [115, 125, 118],
    [108, 118, 110],
    [100, 110, 108], // piso 100
    [106, 116, 114],
    [110, 120, 112], // techo 120
    [104, 114, 106],
    [94, 106, 96], // cierra por debajo de 100 - 2.5: primer cruce
    [90, 100, 92],
    [88, 98, 96], // piso 88
    [96, 106, 104], // cierra por encima de 100 + 2.5: segundo cruce
    [102, 112, 110],
  ];
  const r = niveles(velas(filas, [106, 116, 112]), 112);
  // El 100 ya no es nivel: el soporte que queda es el piso nuevo, en 88.
  assert.deepEqual(r.soporte, { precio: 88, toques: 1, invertido: false });
  assert.deepEqual(r.resistencia, { precio: 120, toques: 1, invertido: false });
});

test('nivel invertido: soporte roto (un cruce) que ahora hace de resistencia', () => {
  const filas = [
    [120, 130, 125],
    [115, 125, 118],
    [108, 118, 110],
    [100, 110, 108], // piso 100
    [106, 116, 114],
    [110, 120, 112], // techo 120 (queda lejos)
    [104, 114, 106],
    [94, 106, 96], // cierra por debajo: un cruce, y el precio ya no vuelve
    [88, 98, 90],
    [84, 94, 86],
    [78, 88, 80],
    [76, 86, 84],
  ];
  const r = niveles(velas(filas, [78, 88, 82]), 82);
  assert.deepEqual(r.resistencia, { precio: 100, toques: 1, invertido: true });
  assert.equal(r.soporte, null); // por debajo no hay ningun piso confirmado: no se inventa
});

test('giro reciente: basta UNA vela cerrada despues del pivote, mas la vela en curso', () => {
  const filas = [
    [100, 110, 108],
    [106, 116, 114],
    [112, 122, 120],
    [118, 128, 126],
    [124, 134, 132],
    [130, 140, 138],
    [136, 146, 144],
    [142, 152, 150],
    [148, 158, 150], // techo 158: el giro mas reciente
    [140, 150, 142], // una sola vela cerrada despues
  ];
  const r = niveles(velas(filas, [134, 144, 136]), 136);
  assert.deepEqual(r.resistencia, { precio: 158, toques: 1, invertido: false });
  // Sin esa vela cerrada despues (solo la vela en curso) todavia no se da por pivote.
  const antes = niveles(velas(filas.slice(0, 9), [140, 150, 142]), 142);
  assert.equal(antes.resistencia, null);
  // Y si la vela en curso ya lo supero, tampoco.
  const superado = niveles(velas(filas, [150, 160, 159]), 159);
  assert.equal(superado.resistencia, null);
});

test('nivel pegado al precio (a menos de media vela tipica) se ignora', () => {
  const pegado = niveles(velas(BASE, [98, 108, 103]), 103); // a 3 del piso de 100
  assert.equal(pegado.soporte, null);
  const separado = niveles(velas(BASE, [101, 111, 106]), 106); // a 6: ya cuenta
  assert.deepEqual(separado.soporte, { precio: 100, toques: 1, invertido: false });
});

test('pivotes a menos de 1/4 de vela se agrupan y, un poco mas lejos, se prefiere el de mas toques', () => {
  const filas = [
    [120, 130, 125],
    [115, 125, 118],
    [108, 118, 110],
    [100, 110, 108], // piso 100
    [106, 116, 114],
    [112, 122, 120],
    [116, 126, 118], // techo 126
    [110, 120, 112],
    [104, 114, 106],
    [101.5, 111.5, 110], // piso 101.5: mismo nivel que el de 100 (a 1.5)
    [108, 118, 116],
    [114, 124, 122],
    [116, 126, 118], // techo 126 otra vez
    [110, 120, 112],
    [107, 117, 115], // piso 107: el mas cercano, pero con un solo toque
    [112, 122, 120],
    [114, 124, 116],
  ];
  const r = niveles(velas(filas, [110, 120, 114]), 114);
  assert.deepEqual(r.soporte, { precio: 100.75, toques: 2, invertido: false });
  assert.deepEqual(r.resistencia, { precio: 126, toques: 2, invertido: false });
});

test('solo mira las ultimas 80 velas cerradas y no falla con datos raros', () => {
  // Un piso muy viejo (fuera de la ventana) no cuenta.
  const viejas = [...BASE.slice(0, 5), ...Array.from({ length: 80 }, (_, i) => [130 + (i % 2), 140 + (i % 2), 135])];
  const r = niveles(velas(viejas, [130, 140, 136]), 136);
  assert.ok(!r.soporte || r.soporte.precio !== 100);
  assert.equal(niveles([], 100).estado, 'sin nivel');
  assert.equal(niveles(velas(BASE, [120, 130, 125]), NaN).estado, 'sin nivel');
  // Velas planas (rango 0): no hay vela tipica con la que medir.
  const planas = Array.from({ length: 12 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
  assert.equal(niveles(planas, 100).estado, 'sin nivel');
});
