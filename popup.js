import { fmtSize, kindLabel, shortName } from './shared.js';

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

async function download(url, b) {
  b.disabled = true;
  const r = await send({ type: 'download', url });
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
  const key = r.items.map((i) => i.url + i.size).join('|');
  if (key === lastKey) return;
  lastKey = key;
  if (!r.items.length) { $list.innerHTML = '<div class="empty">No se detectaron videos. Reproduce el video y vuelve a abrir.</div>'; return; }
  $list.replaceChildren(...r.items.map((it) => {
    const meta = [kindLabel[it.kind], fmtSize(it.size), it.src.join('+')].filter(Boolean).join(' · ');
    const copy = button('Copiar', 'c', (b) => navigator.clipboard.writeText(it.url).then(() => { b.textContent = '✓'; }), it.url);
    const dl = it.kind === 'blob'
      ? button('Bajar', '', null, 'Stream interno de la página; usa la entrada HLS o Archivo')
      : button(it.kind === 'hls' ? 'Unir y bajar' : 'Bajar', '', (b) => download(it.url, b), it.kind === 'dash' ? 'DASH: se baja el manifiesto .mpd' : '');
    const el = row(shortName(it.url), meta, [copy, dl]);
    el.querySelector('.t').title = it.url;
    return el;
  }));
}

refresh();
setInterval(refresh, 1000);
