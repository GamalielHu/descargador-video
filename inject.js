// Mundo MAIN: avisa de URLs multimedia pedidas por fetch/XHR (cubre peticiones que webRequest no asocia a la pestaña, p. ej. vía service worker de la página).
(() => {
  if (window.__vdlHook) return;
  window.__vdlHook = true;
  const RX = /\.(m3u8|mpd|mp4|m4v|webm|ogv|mov|mkv)(?:$|[?#])/i;
  const post = (u) => {
    try {
      const url = String(u && u.url ? u.url : u);
      if (RX.test(url)) window.postMessage({ __vdl: 1, url: new URL(url, location.href).href }, '*');
    } catch {}
  };
  const f = window.fetch;
  if (f) window.fetch = function (input) { post(input); return f.apply(this, arguments); };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { post(u); return open.apply(this, arguments); };

  // ---------- Captura pasiva MSE: copia lo que el reproductor ya agrega a sus SourceBuffer ----------
  // Solo con el interruptor activo (mse-flag.js). Nada de peticiones propias ni firmas; si hay DRM (EME) se descarta todo.
  if (!window.MediaSource) return;
  const MAX = 2 * 1024 ** 3;                // 2 GB entre todas las pistas
  const tracks = new Map();            // id -> {id, mime, chunks, bytes, ms}
  let rec = false, drm = false, total = 0, seq = 0, notifyT = 0;
  const list = () => [...tracks.values()].map(({ id, mime, bytes }) => ({ id, mime, bytes }));
  const notify = () => { if (!notifyT) notifyT = setTimeout(() => { notifyT = 0; window.postMessage({ __vdlMse: 'tracks', drm, list: drm ? [] : list() }, '*'); }, 1500); };
  const kill = () => { drm = true; tracks.clear(); total = 0; notify(); };

  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = add.apply(this, arguments);
    if (rec && !drm) {
      const t = { id: ++seq, mime: String(mime), chunks: [], bytes: 0 };
      tracks.set(t.id, t);
      sb.__vdl = t;
      this.addEventListener('sourceclose', () => { tracks.delete(t.id); total -= t.bytes; notify(); }, { once: true });
      notify();
    }
    return sb;
  };
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const t = this.__vdl;
    if (t && rec && !drm && total < MAX) {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      t.chunks.push(u8.slice());
      t.bytes += u8.byteLength; total += u8.byteLength;
      notify();
    }
    return append.apply(this, arguments);
  };
  const setKeys = HTMLMediaElement.prototype.setMediaKeys;
  if (setKeys) HTMLMediaElement.prototype.setMediaKeys = function (k) { if (k) kill(); return setKeys.apply(this, arguments); };
  document.addEventListener('encrypted', kill, true);

  window.addEventListener('message', (e) => {
    const d = e.source === window && e.data;
    if (!d || !d.__vdlMseCmd) return;
    if (d.__vdlMseCmd === 'on') rec = true;
    if (d.__vdlMseCmd === 'save' && !drm) {
      const t = tracks.get(d.id);
      if (!t) return;
      const url = URL.createObjectURL(new Blob(t.chunks, { type: t.mime.split(';')[0] }));
      window.postMessage({ __vdlMse: 'blob', url, name: d.name }, '*'); // content.js lo pasa a chrome.downloads
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
  });
})();
