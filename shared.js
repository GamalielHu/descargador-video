// Utilidades comunes (background + popup).
export const fmtSize = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

export const kindLabel = { file: 'Archivo', hls: 'HLS', dash: 'DASH', blob: 'Blob' };

export const shortName = (url) => {
  try {
    const p = new URL(url);
    return decodeURIComponent(p.pathname.split('/').filter(Boolean).pop() || p.hostname);
  } catch { return url.slice(0, 60); }
};
