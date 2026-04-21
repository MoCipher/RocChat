// Service worker registration — external file to avoid inline script CSP violations.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(function () {});
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then(function (r) {
        r && r.update();
      });
    }
  });
}
