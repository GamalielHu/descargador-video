# Descargador de Video (Chrome MV3)

Detecta videos de la pestaña por dos vías: cabeceras HTTP en el service worker (`webRequest`) y escaneo del DOM (`MutationObserver` + interceptor de `fetch`/XHR). Descarga archivos directos (`.mp4`, `.webm`, `.ogv`, `.mov`…) y une streams HLS (`.m3u8`) sin cifrar en un solo `.ts`/`.mp4`.

No descarga contenido con DRM (Widevine) ni streams cifrados.

## Instalar
1. Baja `descargador-video.zip` del último [Release](../../releases/latest) y descomprímelo.
2. `chrome://extensions` → activa **Modo de desarrollador** → **Cargar descomprimida** → elige la carpeta.

## Archivos
| Archivo | Función |
|---|---|
| `manifest.json` | Permisos y registro de scripts |
| `background.js` | Captura por red, estado por pestaña, descargas |
| `inject.js` | Interceptor `fetch`/XHR (mundo MAIN) |
| `content.js` | Escaneo del DOM y panel flotante |
| `popup.html/js`, `shared.js` | Lista de videos de la pestaña |
| `offscreen.html/js` | Une segmentos HLS |
