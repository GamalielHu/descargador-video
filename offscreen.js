// Documento offscreen: une segmentos HLS sin cifrar y baja archivos grandes en varios pedazos a la vez.
const CONC = 8;        // segmentos HLS en paralelo
const FILE_CONC = 6;   // conexiones por archivo directo
const CHUNK = 4 << 20; // 4 MB por pedazo
const urls = new Set();

async function get(url, as = 'text', range) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { credentials: 'include', headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : {} });
      if (!r.ok || (range && r.status !== 206)) throw new Error(`HTTP ${r.status}`);
      return as === 'text' ? await r.text() : await r.arrayBuffer();
    } catch (e) { err = e; await new Promise((ok) => setTimeout(ok, 500 * (i + 1))); }
  }
  throw new Error(`${err.message} en ${url.slice(0, 80)}`);
}

function parse(text, base) {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('No es una lista HLS');
  const out = { variants: [], segs: [], map: null, crypt: null, audio: false, live: !/#EXT-X-ENDLIST/.test(text) };
  let bw = -1, br = null, last = {};
  for (const l of text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (l.startsWith('#EXT-X-STREAM-INF')) bw = +(/BANDWIDTH=(\d+)/.exec(l)?.[1] || 0);
    else if (l.startsWith('#EXT-X-KEY') || l.startsWith('#EXT-X-SESSION-KEY')) {
      const m = /METHOD=([A-Z0-9-]+)/.exec(l)?.[1];
      if (m && m !== 'NONE') out.crypt = m;
    } else if (l.startsWith('#EXT-X-MAP')) {
      const u = /URI="([^"]+)"/.exec(l);
      if (u) out.map = new URL(u[1], base).href;
    } else if (l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l) && /URI="/.test(l)) out.audio = true;
    else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, o] = l.slice(17).split('@').map(Number);
      br = [n, o];
    } else if (!l.startsWith('#')) {
      const u = new URL(l, base).href;
      if (bw >= 0) { out.variants.push({ bw, u }); bw = -1; continue; }
      let range;
      if (br) {
        const start = Number.isFinite(br[1]) ? br[1] : (last[u] || 0);
        range = [start, start + br[0] - 1];
        last[u] = start + br[0];
        br = null;
      }
      out.segs.push({ u, range });
    }
  }
  return out;
}

async function run({ id, url, name }) {
  const prog = (o) => chrome.runtime.sendMessage({ type: 'hls-progress', id, ...o }).catch(() => {});
  try {
    let pl = parse(await get(url), url);
    let audio = pl.audio;
    if (pl.variants.length) {
      const best = pl.variants.sort((a, b) => b.bw - a.bw)[0];
      if (pl.crypt) throw new Error('Stream cifrado/protegido: no se puede descargar.');
      pl = parse(await get(best.u), best.u);
    }
    if (pl.crypt) throw new Error(`Stream cifrado (${pl.crypt}): no se puede descargar.`);
    if (!pl.segs.length) throw new Error('La lista no tiene segmentos.');
    const warn = [audio && 'audio en pista separada: el archivo puede salir sin sonido', pl.live && 'transmisión en vivo: solo se baja lo disponible ahora'].filter(Boolean).join('; ');
    const parts = new Array(pl.segs.length);
    let done = 0;
    prog({ done, total: parts.length, warn });
    await pool(CONC, parts.length, async (k) => {
      parts[k] = await get(pl.segs[k].u, 'buf', pl.segs[k].range);
      if (++done % 5 === 0 || done === parts.length) prog({ done, total: parts.length, warn });
    });
    const mp4 = !!pl.map || /\.(mp4|m4s)(?:$|[?#])/i.test(pl.segs[0].u);
    if (pl.map) parts.unshift(await get(pl.map, 'buf'));
    const blobUrl = URL.createObjectURL(new Blob(parts, { type: mp4 ? 'video/mp4' : 'video/mp2t' }));
    urls.add(blobUrl);
    chrome.runtime.sendMessage({ type: 'hls-done', id, name, blobUrl, ext: mp4 ? 'mp4' : 'ts' });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'hls-done', id, error: e.message });
  }
}

async function pool(n, count, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, count) }, async () => { while (next < count) await fn(next++); }));
}

// Archivo directo por rangos HTTP; si el servidor no acepta Range, avisa para usar la descarga normal de Chrome.
async function runFile({ id, url, name, ext, mime }) {
  const prog = (o) => chrome.runtime.sendMessage({ type: 'hls-progress', id, ...o }).catch(() => {});
  try {
    const probe = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-0' } });
    const size = +(/\/(\d+)\s*$/.exec(probe.headers.get('content-range') || '')?.[1] || 0);
    probe.body?.cancel();
    if (probe.status !== 206 || !size) { chrome.runtime.sendMessage({ type: 'hls-done', id, fallback: true }); return; }
    const total = Math.ceil(size / CHUNK);
    const parts = new Array(total);
    let done = 0;
    prog({ done, total, state: 'descargando' });
    await pool(FILE_CONC, total, async (k) => {
      parts[k] = await get(url, 'buf', [k * CHUNK, Math.min(size, (k + 1) * CHUNK) - 1]);
      if (++done % 4 === 0 || done === total) prog({ done, total, state: 'descargando' });
    });
    const blobUrl = URL.createObjectURL(new Blob(parts, { type: mime || 'video/mp4' }));
    urls.add(blobUrl);
    chrome.runtime.sendMessage({ type: 'hls-done', id, name, blobUrl, ext });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'hls-done', id, fallback: true, error: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls') run(msg);
  else if (msg.type === 'file') runFile(msg);
  else if (msg.type === 'revoke' && urls.delete(msg.blobUrl)) URL.revokeObjectURL(msg.blobUrl);
});
