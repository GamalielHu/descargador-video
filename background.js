// Service worker: detección por cabeceras HTTP, estado por pestaña y descargas.
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv|flv|m3u8|mpd)(?:$|[?#])/i;
const SEGMENT = /\.(ts|m4s|m4a|aac|key|vtt)(?:$|[?#])/i;
const MEDIA_MIME = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
const NOT_MEDIA = /^(image\/|text\/html|font\/|text\/css)|mp2t/i;
const MIN_SIZE = 100 * 1024;
const MULTI_MIN = 16 << 20, MULTI_MAX = 1536 << 20; // rango de tamaño para descarga en varios pedazos (en RAM)
const MAX_ITEMS = 200;
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
  const n = Object.keys(st.items).length;
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
    if (!cur.src.includes(it.src)) cur.src.push(it.src);
  } else {
    const keys = Object.keys(st.items);
    if (keys.length >= MAX_ITEMS) delete st.items[keys[0]];
    st.items[url] = { url, kind: it.kind || kindOf(url, it.mime), mime: it.mime || '', size: it.size || 0, src: [it.src], t: Date.now() };
  }
  persist(tabId, st);
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
  add(d.tabId, { url: d.url, mime, size, kind, src: 'red' });
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

async function download(tabId, url) {
  const st = await load(tabId);
  const it = st.items[url] || { url, kind: kindOf(url) };
  const name = clean(st.title);
  if (it.kind === 'blob') throw new Error('Un blob: no se puede descargar directo; usa la entrada HLS/red de la lista.');
  const ext = extOf(it);
  const multi = it.kind === 'file' && it.size >= MULTI_MIN && it.size <= MULTI_MAX;
  if (it.kind !== 'hls' && !multi) {
    await chrome.downloads.download({ url: it.url, filename: `${name}.${ext}`, conflictAction: 'uniquify' });
    return { ok: true };
  }
  const id = crypto.randomUUID();
  jobs.set(id, { tabId, url: it.url, name, ext, done: 0, total: 0, state: 'iniciando' });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: multi ? 'file' : 'hls', id, url: it.url, name, ext, mime: it.mime }).catch(() => {});
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
      load(tabId).then((st) => reply({
        title: st.title,
        items: Object.values(st.items).sort((a, b) => (b.size || 0) - (a.size || 0)),
        jobs: [...jobs.entries()].filter(([, j]) => j.tabId === tabId).map(([id, j]) => ({ id, ...j })),
      }));
      return true;
    case 'download':
      download(tabId, msg.url).then(reply, (e) => reply({ ok: false, error: e.message }));
      return true;
    case 'hls-progress': {
      const j = jobs.get(msg.id);
      if (j) Object.assign(j, { done: msg.done, total: msg.total, state: msg.state || 'descargando', warn: msg.warn });
      return;
    }
    case 'hls-done': {
      const j = jobs.get(msg.id);
      if (msg.fallback && j) { // servidor sin Range: descarga normal de Chrome
        chrome.downloads.download({ url: j.url, filename: `${j.name}.${j.ext}`, conflictAction: 'uniquify' })
          .then(() => { j.state = 'listo'; }, (e) => Object.assign(j, { state: 'error', error: e.message }));
        return;
      }
      if (msg.error) { if (j) Object.assign(j, { state: 'error', error: msg.error }); return; }
      chrome.downloads.download({ url: msg.blobUrl, filename: `${clean(msg.name)}.${msg.ext}`, conflictAction: 'uniquify' })
        .then((dlId) => { blobs.set(dlId, msg.blobUrl); if (j) j.state = 'listo'; })
        .catch((e) => { if (j) Object.assign(j, { state: 'error', error: e.message }); });
      return;
    }
  }
});
