// Service worker: detección por cabeceras HTTP, estado por pestaña y descargas.
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv|flv|m3u8|mpd)(?:$|[?#])/i;
const SEGMENT = /\.(ts|m4s|m4a|aac|key|vtt)(?:$|[?#])/i;
const MEDIA_MIME = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const NOT_MEDIA = /^(image\/|text\/html|font\/|text\/css)|mp2t/i;
const MIN_SIZE = 100 * 1024;
const MULTI_MIN = 16 << 20, MULTI_MAX = 1536 << 20; // rango de tamaño para descarga en varios pedazos (en RAM)
const MAX_ITEMS = 200;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv|flv|avi|wmv|3gp)$/i;
const EXT_BY_MIME = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/x-flv': 'flv' };

// ---------- estado por pestaña (memoria + storage.session para sobrevivir al reinicio del SW) ----------
const tabs = new Map();   // tabId -> Promise<{title, items:{[url]:item}}>
const timers = new Map();
const jobs = new Map();   // jobId -> {tabId, name, done, total, state, error}

const key = (id) => 't' + id;
function load(tabId) {
  let p = tabs.get(tabId);
  if (!p) {
    p = chrome.storage.session.get(key(tabId)).then((r) => r[key(tabId)] || { title: '', items: {} });
    tabs.set(tabId, p);
  }
  return p;
}
function persist(tabId, st) {
  clearTimeout(timers.get(tabId));
  timers.set(tabId, setTimeout(() => {
    timers.delete(tabId);
    chrome.storage.session.set({ [key(tabId)]: st }).catch(() => {});
  }, 400));
  const vs = variantUrls(st);
  const n = Object.values(st.items).filter((it) => isVideo(it) && !vs.has(it.url)).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: 'count', n }, { frameId: 0 }).catch(() => {});
}
function reset(tabId) {
  tabs.delete(tabId);
  clearTimeout(timers.get(tabId));
  chrome.storage.session.remove(key(tabId)).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

const kindOf = (url, mime = '') =>
  url.startsWith('blob:') ? 'blob'
    : /mpegurl/i.test(mime) || /\.m3u8(?:$|[?#])/i.test(url) ? 'hls'
    : /dash\+xml/i.test(mime) || /\.mpd(?:$|[?#])/i.test(url) ? 'dash'
    : 'file';

async function add(tabId, it) {
  if (tabId < 0 || !it.url) return;
  const url = it.url.split('#')[0];
  const st = await load(tabId);
  const cur = st.items[url];
  if (cur) {
    cur.size = cur.size || it.size || 0;
    cur.mime = cur.mime || it.mime || '';
    cur.fname = cur.fname || it.fname || '';
    cur.res = it.res || cur.res || '';
    if (!cur.src.includes(it.src)) cur.src.push(it.src);
  } else {
    const keys = Object.keys(st.items);
    if (keys.length >= MAX_ITEMS) delete st.items[keys[0]];
    st.items[url] = { url, kind: it.kind || kindOf(url, it.mime), mime: it.mime || '', size: it.size || 0, fname: it.fname || '', res: it.res || '', src: [it.src], t: Date.now() };
    if (!st.items[url].size && st.items[url].kind === 'file') probeSize(tabId, url);
    if (st.items[url].kind === 'hls') probeHls(tabId, url);
  }
  persist(tabId, st);
}

// Nombre original: Content-Disposition o último tramo de la URL.
function fileName(it) {
  if (it.fname) return it.fname;
  try { return decodeURIComponent(new URL(it.url).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
}
const isVideo = (it) => it.kind === 'hls' || (it.kind === 'file' && VIDEO_EXT.test(fileName(it)));

// Calidades HLS: lee la lista maestra, cada variante y estima el peso (BANDWIDTH × duración).
const hlsDuration = (t) => [...t.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + +m[1], 0);
const hlsCrypt = (t) => /#EXT-X-(SESSION-)?KEY:[^\n]*METHOD=(?!NONE)/.test(t);
async function probeHls(tabId, url) {
  try {
    const text = await (await fetch(url, { credentials: 'include' })).text();
    const out = { crypt: hlsCrypt(text), variants: [] };
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const u = lines.slice(i + 1).find((x) => x && !x.startsWith('#'));
      if (!u) return;
      const res = /RESOLUTION=(\d+x\d+)/.exec(l)?.[1] || '';
      out.variants.push({ url: new URL(u, url).href, bw: +(/[^-]BANDWIDTH=(\d+)/.exec(',' + l.slice(18))?.[1] || 0), res });
    });
    if (out.variants.length) {
      await Promise.all(out.variants.slice(0, 10).map(async (v) => {
        try {
          const t = await (await fetch(v.url, { credentials: 'include' })).text();
          v.dur = hlsDuration(t);
          v.size = Math.round((v.bw / 8) * v.dur);
          if (hlsCrypt(t)) out.crypt = true;
        } catch {}
      }));
      out.variants.sort((a, b) => (parseInt(b.res.split('x')[1]) || 0) - (parseInt(a.res.split('x')[1]) || 0) || b.bw - a.bw);
    } else out.dur = hlsDuration(text);
    const st = await load(tabId);
    const it = st.items[url];
    if (!it) return;
    Object.assign(it, out, out.variants.length ? { size: out.variants[0].size || 0 } : {});
    persist(tabId, st);
  } catch {}
}
// Las variantes que el reproductor pide sueltas se ocultan si ya están dentro de una lista maestra.
const variantUrls = (st) => new Set(Object.values(st.items).flatMap((i) => (i.variants || []).map((v) => v.url)));

// Peso de lo detectado solo en el DOM (sin cabeceras): HEAD y, si no hay, Range 0-0.
async function probeSize(tabId, url) {
  // HEAD y Range 0-0 en paralelo, máx. 6 s: gana el primero que dé un tamaño.
  const opt = { credentials: 'include', signal: AbortSignal.timeout(6000) };
  const viaHead = fetch(url, { ...opt, method: 'HEAD' }).then((r) => (r.ok && +(r.headers.get('content-length') || 0)) || Promise.reject());
  const viaRange = fetch(url, { ...opt, headers: { Range: 'bytes=0-0' } }).then((r) => {
    r.body?.cancel();
    const n = +(/\/(\d+)\s*$/.exec(r.headers.get('content-range') || '')?.[1] || 0) || (r.status === 200 && +(r.headers.get('content-length') || 0));
    return n || Promise.reject();
  });
  const size = await Promise.any([viaHead, viaRange]).catch(() => 0);
  const st = await load(tabId);
  const it = st.items[url];
  if (!it) return;
  it.probed = true;
  if (size && size < MIN_SIZE) delete st.items[url]; else if (size) it.size = size;
  persist(tabId, st);
}

function dispositionName(v) {
  const m = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(v) || /filename\s*=\s*"?([^";]+)"?/i.exec(v);
  if (!m) return '';
  try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
}

const totalSize = (h) => {
  const r = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  return r ? +r[1] : +(h['content-length'] || 0);
};

// ---------- captura pasiva por cabeceras de red ----------
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const h = {};
  for (const { name, value } of d.responseHeaders || []) h[name.toLowerCase()] = value || '';
  const mime = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (NOT_MEDIA.test(mime) || SEGMENT.test(d.url)) return;
  if (!MEDIA_MIME.test(mime) && !MEDIA_EXT.test(d.url)) return;
  const kind = kindOf(d.url, mime);
  const size = totalSize(h);
  if (kind === 'file' && size && size < MIN_SIZE) return;
  add(d.tabId, { url: d.url, mime, size, kind, fname: dispositionName(h['content-disposition'] || ''), src: 'red' });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url) reset(tabId); });
chrome.tabs.onRemoved.addListener(reset);

// Inyecta content.js en pestañas ya abiertas al instalar/actualizar.
chrome.runtime.onInstalled.addListener(async () => {
  for (const t of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] }).catch(() => {});
  }
});

// ---------- descargas ----------
const clean = (s) => (s || 'video').replace(/[\\/:*?"<>|~\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || 'video';

function extOf(it) {
  if (it.kind === 'dash') return 'mpd';
  const m = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(new URL(it.url).pathname);
  return (m && MEDIA_EXT.test('.' + m[1]) && m[1].toLowerCase()) || EXT_BY_MIME[it.mime] || 'mp4';
}

let offscreenReady = null;
function ensureOffscreen() {
  return (offscreenReady ||= chrome.offscreen.hasDocument().then((has) => has || chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Unir segmentos HLS en un solo archivo',
  })).catch((e) => { offscreenReady = null; throw e; }));
}

// Chrome ignora `filename` en algunas descargas (blob: de la extensión, redirecciones); se fuerza aquí.
const names = new Map(); // url -> nombre
function save(url, filename) {
  names.set(url, filename);
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
}
chrome.downloads.onDeterminingFilename.addListener((d, suggest) => {
  const f = names.get(d.url) || names.get(d.finalUrl);
  if (!f) return;
  names.delete(d.url); names.delete(d.finalUrl);
  suggest({ filename: f, conflictAction: 'uniquify' });
});

// Título de la pestaña aunque el marco principal no haya reportado nada.
async function tabTitle(tabId, st) {
  if (!st.title) { try { st.title = (await chrome.tabs.get(tabId)).title || ''; } catch {} }
  return st.title;
}

const qLabel = (res) => (res ? `${res.split('x')[1]}p` : '');

async function download(tabId, url, variant) {
  const st = await load(tabId);
  const it = st.items[url] || { url, kind: kindOf(url) };
  const orig = it.kind === 'file' ? fileName(it) : '';
  const v = (it.variants || []).find((x) => x.url === variant);
  if (it.crypt) throw new Error('Stream cifrado/protegido: no se puede descargar.');
  const name = clean(orig ? orig.replace(/\.[^.]+$/, '') : [await tabTitle(tabId, st), qLabel(v?.res)].filter(Boolean).join(' '));
  if (it.kind === 'blob') throw new Error('Un blob: no se puede descargar directo; usa la entrada HLS/red de la lista.');
  const ext = (VIDEO_EXT.exec(orig)?.[1] || extOf(it)).toLowerCase();
  const multi = it.kind === 'file' && it.size >= MULTI_MIN && it.size <= MULTI_MAX;
  if (it.kind !== 'hls' && !multi) {
    await save(it.url, `${name}.${ext}`);
    return { ok: true };
  }
  const id = crypto.randomUUID();
  jobs.set(id, { tabId, url: it.url, name, ext, done: 0, total: 0, state: 'iniciando' });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: multi ? 'file' : 'hls', id, url: v?.url || it.url, name, ext, mime: it.mime }).catch(() => {});
  return { ok: true, job: id };
}

const blobs = new Map(); // downloadId -> blobUrl
chrome.downloads.onChanged.addListener((d) => {
  const st = d.state && d.state.current;
  if (!blobs.has(d.id) || (st !== 'complete' && st !== 'interrupted')) return;
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl: blobs.get(d.id) }).catch(() => {});
  blobs.delete(d.id);
});

// ---------- mensajes ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return;
  const tabId = msg.tabId ?? sender.tab?.id;
  switch (msg.type) {
    case 'found':
      load(tabId).then((st) => { if (sender.frameId === 0 && msg.title) st.title = msg.title; });
      for (const it of msg.items || []) add(tabId, { ...it, src: 'dom' });
      return;
    case 'list':
      load(tabId).then(async (st) => (await tabTitle(tabId, st), st)).then((st) => reply({
        title: st.title,
        items: ((vs) => Object.values(st.items).filter((it) => isVideo(it) && !vs.has(it.url)))(variantUrls(st))
          .map((it) => ({ ...it, name: it.kind === 'hls' ? st.title || fileName(it) : fileName(it) }))
          .sort((a, b) => (b.size || 0) - (a.size || 0)),
        jobs: [...jobs.entries()].filter(([, j]) => j.tabId === tabId).map(([id, j]) => ({ id, ...j })),
      }));
      return true;
    case 'download':
      download(tabId, msg.url, msg.variant).then(reply, (e) => reply({ ok: false, error: e.message }));
      return true;
    case 'hls-progress': {
      const j = jobs.get(msg.id);
      if (j) Object.assign(j, { done: msg.done, total: msg.total, state: msg.state || 'descargando', warn: msg.warn });
      return;
    }
    case 'hls-done': {
      const j = jobs.get(msg.id);
      if (msg.fallback && j) { // servidor sin Range: descarga normal de Chrome
        save(j.url, `${j.name}.${j.ext}`)
          .then(() => { j.state = 'listo'; }, (e) => Object.assign(j, { state: 'error', error: e.message }));
        return;
      }
      if (msg.error) { if (j) Object.assign(j, { state: 'error', error: msg.error }); return; }
      save(msg.blobUrl, `${clean(msg.name)}.${msg.ext}`)
        .then((dlId) => { blobs.set(dlId, msg.blobUrl); if (j) j.state = 'listo'; })
        .catch((e) => { if (j) Object.assign(j, { state: 'error', error: e.message }); });
      return;
    }
  }
});
