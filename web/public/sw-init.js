// Service worker registration — external file to avoid inline script CSP violations.
// Create a minimal Trusted Types policy for the SW URL sink, since the main
// app policy in app.ts may not be loaded yet when this runs.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var swUrl = '/sw.js';
  try {
    var tt = window.trustedTypes;
    if (tt && typeof tt.createPolicy === 'function') {
      var policy = tt.createPolicy('sw-init', {
        createScriptURL: function (s) { return s; }
      });
      swUrl = policy.createScriptURL('/sw.js');
    }
  } catch (e) { /* TT unavailable */ }
  navigator.serviceWorker.register(swUrl).catch(function () {});
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      navigator.serviceWorker.getRegistration().then(function (r) {
        r && r.update();
      });
    }
  });
})();
