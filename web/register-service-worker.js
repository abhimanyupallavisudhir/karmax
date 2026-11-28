// An app that keeps files offline also keeps the console's own files, to open
// without a network (the offline shell: web/service-worker.js, wiki features/offline-files).
if ('serviceWorker' in navigator) {
  let shell = false;
  try { shell = !!window.Capacitor?.isNativePlatform?.() && window.Capacitor.isPluginAvailable?.('TavyaOfflineFiles') === true; } catch { /* a browser */ }
  navigator.serviceWorker.register(shell ? '/service-worker.js?shell=1' : '/service-worker.js').catch(() => {});
}
