// Mundo aislado, document_start: activa la captura MSE en inject.js si el usuario la encendió en el popup.
chrome.storage.local.get('mse').then(({ mse }) => { if (mse) window.postMessage({ __vdlMseCmd: 'on' }, '*'); }).catch(() => {});
