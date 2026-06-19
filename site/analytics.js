// First-party, cookieless analytics for the marketing site.
//
// Sends anonymous {type, path, ref} events to the Codenomics control panel's
// /beacon ingest — the same local server that renders the :3939 analytics view.
// No cookies, no third party, no PII (we send the URL path and referrer only),
// consistent with privacy.html.
//
// Endpoint resolution:
//   • localhost / 127.0.0.1 (the dev preview) -> the control panel on :3939,
//     live right now — events show up in :3939 as you click around.
//   • production (codenomics.ai)              -> PROD_BEACON, intentionally
//     empty until a public transport is chosen. While empty, every send() is a
//     silent no-op — so this ships safely to prod and tracks nothing there until
//     that single line is set.
(function () {
  var PROD_BEACON = ''; // set to the public ingest URL once prod transport is wired

  var host = location.hostname;
  var isLocal = host === '127.0.0.1' || host === 'localhost';
  var ENDPOINT = isLocal ? 'http://127.0.0.1:3939/beacon' : PROD_BEACON;

  function send(type, value) {
    if (!ENDPOINT) return;
    try {
      var payload = { type: type, path: location.pathname, ref: document.referrer || null };
      if (typeof value === 'number' && isFinite(value)) payload.v = Math.round(value);
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, body); // text/plain; the ingest accepts it
      } else {
        fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' });
      }
    } catch (e) { /* analytics must never break the page */ }
  }

  // Dwell: how long this page actually held attention. We accumulate only the
  // time the tab is *visible*, then flush once when the visitor first leaves
  // (visibilitychange->hidden is the reliable "leaving" signal; pagehide is the
  // belt-and-braces fallback). Sent as a `dwell` event carrying elapsed ms in
  // `v`, so the control panel can show median time-on-page per path. One dwell
  // per pageview keeps the medians clean.
  var visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;
  var dwellMs = 0, dwellSent = false;
  function flushDwell() {
    if (dwellSent) return;
    if (visibleSince) { dwellMs += Date.now() - visibleSince; visibleSince = 0; }
    if (dwellMs > 0) { dwellSent = true; send('dwell', dwellMs); }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushDwell();
    else if (!visibleSince && !dwellSent) visibleSince = Date.now();
  });
  window.addEventListener('pagehide', flushDwell);

  // Exposed so install-modal.js can emit its own funnel events.
  window.cnBeacon = send;

  // Top of funnel: one pageview per load.
  send('pageview');

  // CTA / copy intent anywhere on the page, via the [data-beacon] convention.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-beacon]');
    if (el) send(el.getAttribute('data-beacon'));
  });
})();
