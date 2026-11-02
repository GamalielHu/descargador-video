// Documento offscreen: descarga una lista HLS sin cifrar y une sus segmentos en un archivo.
const CONC = 4;
const urls = new Set();

async function get(url, as = 'text', range) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { credentials: 'include', headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : {} });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
    let done = 0, next = 0;
    prog({ done, total: parts.length, warn });
    await Promise.all(Array.from({ length: Math.min(CONC, parts.length) }, async () => {
      while (next < parts.length) {
        const k = next++;
        parts[k] = await get(pl.segs[k].u, 'buf', pl.segs[k].range);
        if (++done % 5 === 0 || done === parts.length) prog({ done, total: parts.length, warn });
      }
    }));
    const mp4 = !!pl.map || /\.(mp4|m4s)(?:$|[?#])/i.test(pl.segs[0].u);
    if (pl.map) parts.unshift(await get(pl.map, 'buf'));
    const blobUrl = URL.createObjectURL(new Blob(parts, { type: mp4 ? 'video/mp4' : 'video/mp2t' }));
    urls.add(blobUrl);
    chrome.runtime.sendMessage({ type: 'hls-done', id, name, blobUrl, ext: mp4 ? 'mp4' : 'ts' });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'hls-done', id, error: e.message });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls') run(msg);
  else if (msg.type === 'revoke' && urls.delete(msg.blobUrl)) URL.revokeObjectURL(msg.blobUrl);
});
