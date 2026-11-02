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
})();
