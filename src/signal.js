/**
 * Senal por reglas de analisis tecnico, como las de los "bots de senales":
 * medias moviles (tendencia) + RSI (sobrecompra / sobreventa).
 *
 * IMPORTANTE: esto DESCRIBE lo que ya paso en la grafica. No predice la
 * siguiente vela. Por eso el programa mide aparte cuantas veces acierta.
 */

const MIN_CANDLES = 8; // velas cerradas necesarias para dar senal
const FAST = 5;
const SLOW = 10;
const RSI_PERIOD = 7;

/** Media movil exponencial; devuelve el ultimo valor. */
function ema(values, period) {
  const k = 2 / (period + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

/** RSI clasico sobre las ultimas `period` variaciones (0-100). */
function rsi(closes, period) {
  let gain = 0;
  let loss = 0;
  const from = Math.max(1, closes.length - period);
  for (let i = from; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gain += change;
    else loss -= change;
  }
  if (gain + loss === 0) return 50;
  return (100 * gain) / (gain + loss);
}

/**
 * Senal para la vela SIGUIENTE a la ultima de `candles` (todas cerradas).
 * @returns {{ dir: 'up'|'down'|null, trend: 'up'|'down'|'flat', rsi: number|null, reason: string }}
 */
function signalFor(candles) {
  if (candles.length < MIN_CANDLES) {
    return {
      dir: null,
      trend: 'flat',
      rsi: null,
      reason: `Se necesitan al menos ${MIN_CANDLES} velas cerradas (hay ${candles.length}).`,
    };
  }
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const fast = ema(closes, FAST);
  const slow = ema(closes, SLOW);
  const strength = Math.round(rsi(closes, RSI_PERIOD));
  const trend = fast > slow ? 'up' : fast < slow ? 'down' : 'flat';

  if (trend === 'up' && last > fast && strength < 75) {
    return { dir: 'up', trend, rsi: strength, reason: 'Media rápida sobre la lenta y precio sobre la media.' };
  }
  if (trend === 'down' && last < fast && strength > 25) {
    return { dir: 'down', trend, rsi: strength, reason: 'Media rápida bajo la lenta y precio bajo la media.' };
  }
  let reason = 'La tendencia y el precio no coinciden.';
  if (trend === 'up' && strength >= 75) reason = 'Tendencia alcista pero RSI en sobrecompra.';
  if (trend === 'down' && strength <= 25) reason = 'Tendencia bajista pero RSI en sobreventa.';
  return { dir: null, trend, rsi: strength, reason };
}

const TREND_CANDLES = 4; // velas que definen la tendencia reciente (incluida la que esta en curso)

/** Pendiente (por vela) de la recta que mejor ajusta a una serie de valores. */
function slope(values) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, v) => sum + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) * (i - meanX);
  }
  return den ? num / den : 0;
}

/**
 * Senal para ciclos cortos (modo por segundos): la direccion hacia la que van
 * las ultimas velas, contando la que esta en curso. Es lo que una persona ve
 * como "va subiendo" o "va bajando" al mirar la grafica.
 *
 * `candles` debe incluir la vela en curso al final. Es simetrica: la misma
 * grafica volteada da la senal contraria.
 */
function trendSignal(candles) {
  if (candles.length < MIN_CANDLES) {
    return {
      dir: null,
      trend: 'flat',
      rsi: null,
      reason: `Se necesitan al menos ${MIN_CANDLES} velas (hay ${candles.length}). Aleja el zoom.`,
    };
  }
  const recent = candles.slice(-TREND_CANDLES);
  const tilt = slope(recent.map((c) => c.close));
  const typicalSize = recent.reduce((sum, c) => sum + (c.high - c.low), 0) / recent.length || 1;
  const strength = Math.round(rsi(candles.map((c) => c.close), RSI_PERIOD));

  // Una pendiente pequena (menos del 10 % del tamano de una vela por vela) es mercado lateral:
  // asi un zigzag que sube y baja lo mismo no se toma por tendencia.
  if (Math.abs(tilt) < typicalSize * 0.1) {
    return { dir: null, trend: 'flat', rsi: strength, reason: 'Sin tendencia clara: las últimas velas van de lado.' };
  }
  const trend = tilt > 0 ? 'up' : 'down';
  const reason =
    trend === 'up'
      ? `Las últimas ${recent.length} velas van hacia arriba.`
      : `Las últimas ${recent.length} velas van hacia abajo.`;
  return { dir: trend, trend, rsi: strength, reason };
}

/**
 * Lee el patron de una vela (normalmente la que esta en curso) y lo traduce a
 * un voto: +1 empuja hacia arriba, -1 hacia abajo, 0 no dice nada.
 *
 *   - Mecha larga arriba  -> el precio subio y lo regresaron (rechazo): -1
 *   - Mecha larga abajo   -> el precio bajo y lo levantaron (rebote):  +1
 *   - Cuerpo casi nulo    -> indecision (doji):                         0
 *   - Envolvente          -> el cuerpo cubre al de la vela anterior, de color contrario
 *   - Cuerpo fuerte       -> la vela es casi toda cuerpo: empuja en su direccion
 *   - Muy extendida       -> su cuerpo ya es mucho mayor que el de las velas anteriores:
 *                            el movimiento ya ocurrio. No vota y BLOQUEA seguirla
 *                            (`blocks`: direccion en la que no se debe dar senal).
 *
 * `context` son las velas anteriores (para saber que tamano es normal en esta grafica).
 * Es simetrica: la misma vela volteada da el voto y el bloqueo contrarios.
 */
const EXTENDED_FACTOR = 1.5; // cuerpo >= 1.5 veces el cuerpo tipico = vela muy extendida

function candlePattern(candle, previous, context = []) {
  if (!candle) return { vote: 0, text: 'sin vela en curso' };
  const range = candle.high - candle.low;
  if (range <= 0) return { vote: 0, text: 'sin movimiento' };
  const top = Math.max(candle.open, candle.close);
  const bottom = Math.min(candle.open, candle.close);
  const body = top - bottom;
  const upperWick = candle.high - top;
  const lowerWick = bottom - candle.low;
  const up = candle.close > candle.open;
  const down = candle.close < candle.open;

  if (upperWick >= range * 0.5 && upperWick >= body * 2 && upperWick > lowerWick * 2) {
    return { vote: -1, text: 'mecha larga arriba (rechazo)' };
  }
  if (lowerWick >= range * 0.5 && lowerWick >= body * 2 && lowerWick > upperWick * 2) {
    return { vote: 1, text: 'mecha larga abajo (rebote)' };
  }
  // Vela ya muy estirada respecto a lo normal en esta grafica: no se persigue.
  const bodies = context
    .slice(-8)
    .map((c) => Math.abs(c.close - c.open))
    .sort((a, b) => a - b);
  if (bodies.length >= 4 && (up || down)) {
    const typicalBody = bodies[Math.floor((bodies.length - 1) / 2)];
    if (typicalBody > 0 && body >= typicalBody * EXTENDED_FACTOR && body >= range * 0.5) {
      return {
        vote: 0,
        blocks: up ? 'up' : 'down',
        short: `estirada ×${(body / typicalBody).toFixed(1)}`, // version corta para el panel
        text: `ya muy extendida hacia ${up ? 'arriba' : 'abajo'} (${(body / typicalBody).toFixed(1)} veces lo normal)`,
      };
    }
  }

  if (body < range * 0.1) return { vote: 0, text: 'indecisión (cuerpo mínimo)' };

  if (previous) {
    const prevTop = Math.max(previous.open, previous.close);
    const prevBottom = Math.min(previous.open, previous.close);
    const covers = top >= prevTop && bottom <= prevBottom && body > prevTop - prevBottom;
    if (covers && up && previous.close < previous.open) return { vote: 1, text: 'envolvente alcista' };
    if (covers && down && previous.close > previous.open) return { vote: -1, text: 'envolvente bajista' };
  }

  if (body >= range * 0.6) {
    return up ? { vote: 1, text: 'cuerpo fuerte verde' } : { vote: -1, text: 'cuerpo fuerte rojo' };
  }
  return { vote: 0, text: up ? 'verde sin fuerza' : down ? 'roja sin fuerza' : 'sin dirección' };
}

module.exports = { signalFor, trendSignal, candlePattern, slope, ema, rsi, MIN_CANDLES };
