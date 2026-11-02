// Escaneo pasivo del DOM (MutationObserver) + panel flotante en el marco principal.
(() => {
  if (window.__vdlContent) return;
  window.__vdlContent = true;

  const MEDIA = /\.(mp4|m4v|webm|ogv|mov|mkv|m3u8|mpd)(?:$|[?#])/i;
  const seen = new Set();
  let queue = [];
  let flushT = 0;

  const send = (msg) => { try { return chrome.runtime.sendMessage(msg); } catch { return Promise.resolve(); } };

  function report(raw, from) {
    if (!raw) return;
    let url;
    try { url = new URL(raw, location.href).href; } catch { return; }
    if (!/^(https?|blob):/.test(url) || seen.has(url)) return;
    seen.add(url);
    queue.push({ url, from });
    clearTimeout(flushT);
    flushT = setTimeout(() => {
      const items = queue; queue = [];
      send({ type: 'found', items, title: document.title })?.catch?.(() => {});
    }, 300);
  }

  function scanEl(el) {
    if (el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === 'VIDEO') { report(el.currentSrc || el.src, 'video'); el.querySelectorAll('source').forEach((s) => report(s.src, 'source')); }
    else if (tag === 'SOURCE' && el.parentElement?.tagName === 'VIDEO') report(el.src, 'source');
    else if ((tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') && MEDIA.test(el.src || el.data || '')) report(el.src || el.data, 'iframe');
    else if (tag === 'A' && MEDIA.test(el.href)) report(el.href, 'enlace');
    if (el.firstElementChild) el.querySelectorAll('video, iframe, embed, a[href]').forEach(scanEl);
  }

  // Cambios del DOM: agrupados y procesados en un solo pase.
  let pending = new Set(), scanT = 0;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') pending.add(m.target);
      else m.addedNodes.forEach((n) => n.nodeType === 1 && pending.add(n));
    }
    if (!scanT) scanT = setTimeout(() => { scanT = 0; const p = pending; pending = new Set(); p.forEach(scanEl); }, 250);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href'] });
  // src asignado por propiedad (sin atributo): los eventos de medios no burbujean, se capturan.
  document.addEventListener('loadstart', (e) => e.target.tagName === 'VIDEO' && scanEl(e.target), true);
  // URLs de fetch/XHR avisadas por inject.js (mundo MAIN).
  window.addEventListener('message', (e) => { if (e.source === window && e.data && e.data.__vdl === 1 && typeof e.data.url === 'string') report(e.data.url, 'fetch'); });
  scanEl(document.documentElement);

  if (window !== window.top) return;

  // ---------- panel flotante (Shadow DOM cerrado: sin choques de CSS con la página) ----------
  let host, root, btn, list, closed = false, open = false;
  const fmt = (n) => { if (!n) return ''; let i = 0; const u = ['B', 'KB', 'MB', 'GB']; while (n >= 1024 && i < 3) { n /= 1024; i++; } return ` · ${n.toFixed(i ? 1 : 0)} ${u[i]}`; };
  const KIND = { file: 'Archivo', hls: 'HLS', dash: 'DASH', blob: 'Blob' };

  function build() {
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{font:13px system-ui,sans-serif;color:#eee}
      .b{display:flex;gap:6px;align-items:center;background:#1f6feb;color:#fff;border:0;border-radius:20px;padding:8px 12px;cursor:pointer;box-shadow:0 2px 8px #0006;font:inherit}
      .x{background:none;border:0;color:#fff;cursor:pointer;font:inherit;opacity:.8}
      .p{display:none;position:absolute;right:0;bottom:44px;width:340px;max-height:360px;overflow:auto;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:6px;box-shadow:0 4px 16px #0008}
      .p.on{display:block}
      .i{display:flex;gap:6px;align-items:center;padding:6px;border-bottom:1px solid #21262d}
      .i:last-child{border:0}
      .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .m{color:#8b949e;font-size:11px}
      .d{background:#238636;color:#fff;border:0;border-radius:4px;padding:4px 8px;cursor:pointer;font:inherit}
      .d:disabled{background:#30363d;cursor:default}
    </style><div class="p"></div><button class="b"><span>▼ Videos</span><span class="c">0</span><span class="x" title="Ocultar">✕</span></button>`;
    btn = root.querySelector('.b');
    list = root.querySelector('.p');
    btn.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) { closed = true; host.remove(); return; }
      open = !open; list.classList.toggle('on', open); if (open) render();
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('.d');
      if (!b) return;
      b.disabled = true;
      send({ type: 'download', url: b.dataset.u }).then((r) => { b.textContent = r && r.ok ? (r.job ? 'Uniendo…' : 'OK') : 'Error'; if (r && r.error) b.title = r.error; });
    });
    (document.body || document.documentElement).appendChild(host);
  }

  async function render() {
    const r = await send({ type: 'list' });
    if (!r) return;
    list.replaceChildren(...r.items.map((it) => {
      const row = document.createElement('div');
      row.className = 'i';
      const name = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || it.url).slice(0, 80);
      row.innerHTML = '<div class="n"><div class="t"></div><div class="m"></div></div><button class="d">Bajar</button>';
      row.querySelector('.t').textContent = name;
      row.querySelector('.t').title = it.url;
      row.querySelector('.m').textContent = KIND[it.kind] + fmt(it.size);
      const b = row.querySelector('.d');
      b.dataset.u = it.url;
      if (it.kind === 'blob') { b.disabled = true; b.title = 'Stream interno; usa la entrada HLS/Archivo'; }
      return row;
    }));
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'count' || closed) return;
    if (!host) build();
    root.querySelector('.c').textContent = msg.n;
    host.style.display = msg.n ? '' : 'none';
    if (open) render();
  });
})();
