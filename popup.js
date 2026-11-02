import { fmtSize, shortName } from './shared.js';

const $list = document.getElementById('list');
const $jobs = document.getElementById('jobs');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const send = (m) => chrome.runtime.sendMessage({ tabId: tab.id, ...m });
let lastKey = '';

function row(main, meta, buttons, metaCls = '') {
  const d = document.createElement('div');
  d.className = 'i';
  d.innerHTML = '<div class="n"><div class="t"></div><div class="m"></div></div>';
  d.querySelector('.t').textContent = main;
  const m = d.querySelector('.m');
  m.textContent = meta;
  if (metaCls) m.classList.add(metaCls);
  d.append(...buttons);
  return d;
}

function button(text, cls, fn, title = '') {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  if (cls) b.className = cls;
  if (fn) b.addEventListener('click', () => fn(b)); else b.disabled = true;
  return b;
}

const q = (res) => (res ? `${res.split('x')[1]}p` : '');
const optLabel = (v) => [q(v.res) || `${Math.round(v.bw / 1000)} kbps`, v.size && '~' + fmtSize(v.size)].filter(Boolean).join(' · ');

async function download(url, b, variant) {
  b.disabled = true;
  const r = await send({ type: 'download', url, variant });
  b.textContent = r?.ok ? (r.job ? 'Uniendo…' : 'Iniciado') : 'Error';
  if (r?.error) b.title = r.error;
  refresh();
}

async function refresh() {
  const r = await send({ type: 'list' });
  if (!r) return;
  $jobs.replaceChildren(...r.jobs.map((j) => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) + '%' : '';
    const meta = j.state === 'error' ? j.error : `${j.state} ${pct}${j.warn ? ' · ' + j.warn : ''}`;
    return row(`Descargando: ${j.name}`, meta, [], j.state === 'error' ? 'e' : j.warn ? 'w' : '');
  }));
  const key = r.items.map((i) => i.url + i.size + i.probed + i.res + (i.variants || []).length + i.crypt).join('|');
  if (key === lastKey) return;
  lastKey = key;
  if (!r.items.length) { $list.innerHTML = '<div class="empty">No se detectaron archivos de video. Reproduce el video y vuelve a abrir.</div>'; return; }
  $list.replaceChildren(...r.items.map((it) => {
    const vs = it.variants || [];
    const meta = it.kind === 'mse' ? `Captura ${/audio/i.test(it.mime) ? 'audio' : 'video'} · ${fmtSize(it.size) || '0 B'} grabados`
      : it.crypt ? 'Cifrado/DRM: no se puede descargar'
      : it.kind === 'hls' ? (vs.length ? `${vs.length} calidades` : 'Stream HLS' + (it.dur ? ` · ${Math.round(it.dur / 60)} min` : ''))
      : [q(it.res), fmtSize(it.size) || (it.probed ? 'peso desconocido' : 'calculando peso…')].filter(Boolean).join(' · ');
    let sel = null;
    if (vs.length) {
      sel = document.createElement('select');
      vs.forEach((v) => sel.add(new Option(optLabel(v), v.url)));
    }
    const copy = it.kind === 'mse' ? null : button('Copiar', 'c', (b) => navigator.clipboard.writeText(it.url).then(() => { b.textContent = '✓'; }), it.url);
    const dl = it.kind === 'blob'
      ? button('Bajar', '', null, 'Stream interno de la página; usa la entrada HLS o Archivo')
      : button(it.kind === 'hls' ? 'Unir y bajar' : it.kind === 'mse' ? 'Guardar' : 'Bajar', '', it.crypt ? null : (b) => download(it.url, b, sel?.value), it.kind === 'dash' ? 'DASH: se baja el manifiesto .mpd' : '');
    const el = row(it.name || shortName(it.url), meta, [sel, copy, dl].filter(Boolean), it.crypt ? 'e' : '');
    el.querySelector('.t').title = it.url;
    return el;
  }));
}

// Interruptor de captura MSE (se aplica al recargar la página).
const $mse = document.getElementById('mse');
chrome.storage.local.get('mse').then(({ mse }) => { $mse.checked = !!mse; });
$mse.addEventListener('change', () => {
  chrome.storage.local.set({ mse: $mse.checked });
  document.getElementById('mse-tip').textContent = $mse.checked ? 'Recarga la página y reproduce el video completo, sin adelantar.' : '';
});

refresh();
setInterval(refresh, 1000);
