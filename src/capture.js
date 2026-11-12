/**
 * Captura de la pantalla principal y recorte de zonas.
 * Las zonas se guardan en coordenadas "logicas" de la pantalla (las mismas
 * que usa la ventana); aqui se convierten a pixeles reales segun la escala
 * de Windows (125 %, 150 %, ...).
 */
const { screen, desktopCapturer } = require('electron');
const { PNG } = require('pngjs');

/** Captura la pantalla principal a resolucion real. */
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(width * display.scaleFactor),
      height: Math.round(height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) throw new Error('No se pudo capturar la pantalla');
  return { image: source.thumbnail, scale: source.thumbnail.getSize().width / width };
}

// Margen (en puntos de pantalla) que el recorte deja fuera por cada lado, para no capturar el
// borde que dibuja el propio panel. Quien pase de pixeles de la imagen a puntos de pantalla
// tiene que sumarlo: punto = CROP_INSET + pixel / escala.
const CROP_INSET = 2;

/** Recorta una zona { x, y, width, height } de la captura. */
function cropRegion(shot, region) {
  const inset = CROP_INSET;
  return shot.image.crop({
    x: Math.round((region.x + inset) * shot.scale),
    y: Math.round((region.y + inset) * shot.scale),
    width: Math.max(1, Math.round((region.width - inset * 2) * shot.scale)),
    height: Math.max(1, Math.round((region.height - inset * 2) * shot.scale)),
  });
}

/** Convierte una imagen de Electron a pixeles RGBA: { data, width, height }. */
function toPixels(image) {
  const png = PNG.sync.read(image.toPNG());
  return { data: png.data, width: png.width, height: png.height };
}

module.exports = { captureScreen, cropRegion, toPixels, CROP_INSET };
