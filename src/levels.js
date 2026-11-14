/**
 * Soporte y resistencia mas cercanos al precio, medidos sobre las velas que el panel ya tiene.
 *
 * Las velas llegan como { open, high, low, close } (numero mayor = precio mas alto), con la vela
 * EN CURSO al final, mas el precio de este instante. No se inventa nada: con menos de 8 velas
 * cerradas la respuesta es "sin nivel".
 *
 * Como se mide:
 *   1. Ventana: las ultimas 80 velas cerradas, mas la vela en curso.
 *   2. Vela tipica: mediana del rango (maximo - minimo) de las ultimas 20 velas cerradas.
 *   3. Pivotes: una vela es PISO si su minimo es el mas bajo de sus vecinas (3 a la izquierda y
 *      hasta 3 a la derecha) y TECHO si su maximo es el mas alto. Para no perder el giro mas
 *      reciente basta UNA vela cerrada despues del pivote, mas la vela en curso, sin superarlo.
 *   4. Los pivotes a menos de 1/4 de vela tipica entre si son un solo nivel (precio = promedio)
 *      y se cuentan sus toques. Velas pegadas que marcan el mismo extremo son un solo toque.
 *   5. Vigencia: cuantas veces el precio CRUZO el nivel por cierre (con margen de 1/4 de vela
 *      tipica) despues de su ultimo toque, contando el precio actual. 0 = vigente; 1 = invertido
 *      (soporte roto que ahora hace de resistencia, o al reves); 2 o mas = se descarta.
 *   6. Se ignoran los niveles a menos de media vela tipica del precio actual.
 *   7. De cada lado se elige el mas cercano; si hasta una vela tipica mas lejos hay otro con mas
 *      toques, o vigente en vez de invertido, se prefiere ese.
 */
const VENTANA = 80; // velas cerradas que se miran
const VELAS_TIPICA = 20; // velas cerradas con las que se mide la vela tipica
const VECINAS = 3; // vecinas a cada lado de un pivote
const MIN_VELAS = 8; // con menos velas cerradas no hay nivel
const AGRUPAR = 0.25; // pivotes a menos de esto (en velas tipicas) son un mismo nivel
const MARGEN_CRUCE = 0.25; // margen para contar un cruce por cierre (en velas tipicas)
const MUY_CERCA = 0.5; // niveles a menos de esto del precio actual se ignoran (en velas tipicas)
const PREFERIR_HASTA = 1; // hasta esta distancia extra se prefiere un nivel mejor (en velas tipicas)

const SIN_NIVEL = 'sin nivel';

function mediana(valores) {
  const orden = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (orden.length === 0) return 0;
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

/** Pisos y techos de las velas cerradas. `lista` = cerradas + vela en curso; `n` = indice de la vela en curso. */
function pivotes(lista, n) {
  const encontrados = [];
  // Hacen falta 3 vecinas a la izquierda y, a la derecha, al menos una vela cerrada (i + 1 <= n - 1).
  for (let i = VECINAS; i <= n - 2; i++) {
    const vecinas = [...lista.slice(i - VECINAS, i), ...lista.slice(i + 1, Math.min(n, i + VECINAS) + 1)];
    if (vecinas.every((c) => lista[i].low <= c.low)) encontrados.push({ i, precio: lista[i].low, tipo: 'piso' });
    if (vecinas.every((c) => lista[i].high >= c.high)) encontrados.push({ i, precio: lista[i].high, tipo: 'techo' });
  }
  return encontrados;
}

/** De un grupo de pivotes sale un nivel: precio promedio, toques y cuantas veces lo cruzo el precio despues. */
function nivelDe(grupo, cerradas, precio, tipica) {
  const nivel = grupo.reduce((suma, p) => suma + p.precio, 0) / grupo.length;
  const porOrden = [...grupo].sort((a, b) => a.i - b.i);
  // Toques: velas pegadas (una tras otra) que marcan el mismo extremo cuentan como uno solo.
  let toques = 0;
  let previo = -Infinity;
  for (const p of porOrden) {
    if (p.i - previo > 1) toques++;
    previo = p.i;
  }
  // Cruces por cierre despues del ultimo toque, contando el precio actual.
  const ultimo = porOrden[porOrden.length - 1].i;
  const tipos = new Set(porOrden.filter((p) => p.i === ultimo).map((p) => p.tipo));
  // Tras tocar un piso el precio queda arriba; tras un techo, abajo. Si la vela marco las dos cosas, no se sabe.
  let lado = tipos.size === 1 ? (tipos.has('piso') ? 1 : -1) : 0;
  const margen = tipica * MARGEN_CRUCE;
  let cruces = 0;
  for (const cierre of [...cerradas.slice(ultimo + 1).map((c) => c.close), precio]) {
    const ahora = cierre > nivel + margen ? 1 : cierre < nivel - margen ? -1 : 0;
    if (ahora === 0 || ahora === lado) continue;
    if (lado !== 0) cruces++;
    lado = ahora;
  }
  return { precio: nivel, toques, cruces, invertido: cruces === 1 };
}

/** El mas cercano; o, hasta una vela tipica mas lejos, uno con mas toques o vigente en vez de invertido. */
function elegir(lista, precio, tipica) {
  if (lista.length === 0) return null;
  const distancia = (l) => Math.abs(l.precio - precio);
  const orden = [...lista].sort((a, b) => distancia(a) - distancia(b));
  const cercano = orden[0];
  const mejores = orden
    .slice(1)
    .filter((l) => distancia(l) - distancia(cercano) <= tipica * PREFERIR_HASTA)
    .filter((l) => l.toques > cercano.toques || (cercano.invertido && !l.invertido));
  mejores.sort((a, b) => Number(a.invertido) - Number(b.invertido) || b.toques - a.toques || distancia(a) - distancia(b));
  const elegido = mejores[0] || cercano;
  return { precio: elegido.precio, toques: elegido.toques, invertido: elegido.invertido };
}

/**
 * @param {Array<{open:number, high:number, low:number, close:number}>} velas  La vela en curso, al final.
 * @param {number} precio  Precio de este instante (mismas unidades que las velas).
 * @returns {{ estado: 'ok'|'sin nivel', soporte: {precio:number, toques:number, invertido:boolean}|null,
 *             resistencia: {precio:number, toques:number, invertido:boolean}|null, tipica: number }}
 */
function niveles(velas, precio) {
  const nada = { estado: SIN_NIVEL, soporte: null, resistencia: null, tipica: 0 };
  if (!Array.isArray(velas) || velas.length < 2 || !Number.isFinite(precio)) return nada;
  const enCurso = velas[velas.length - 1];
  const cerradas = velas.slice(0, -1).slice(-VENTANA);
  if (cerradas.length < MIN_VELAS) return nada;
  const tipica = mediana(cerradas.slice(-VELAS_TIPICA).map((c) => c.high - c.low));
  if (!(tipica > 0)) return nada;

  // Agrupar: los pivotes a menos de 1/4 de vela tipica entre si son un solo nivel.
  const grupos = [];
  for (const p of pivotes([...cerradas, enCurso], cerradas.length).sort((a, b) => a.precio - b.precio)) {
    const grupo = grupos[grupos.length - 1];
    if (grupo && p.precio - grupo[grupo.length - 1].precio < tipica * AGRUPAR) grupo.push(p);
    else grupos.push([p]);
  }
  const validos = grupos
    .map((grupo) => nivelDe(grupo, cerradas, precio, tipica))
    .filter((l) => l.cruces <= 1) // cruzado dos veces o mas: ya no es un nivel
    .filter((l) => Math.abs(l.precio - precio) >= tipica * MUY_CERCA); // pegado al precio: no dice nada
  return {
    estado: 'ok',
    soporte: elegir(validos.filter((l) => l.precio < precio), precio, tipica),
    resistencia: elegir(validos.filter((l) => l.precio > precio), precio, tipica),
    tipica,
  };
}

module.exports = { niveles, SIN_NIVEL, VENTANA, MIN_VELAS };
