/* On-screen start-up diagnostics - off unless the page is opened with ?debug.
   For a phone with no console (iOS Safari): open  <game url>/?debug  and
   take a screenshot.  The panel (top-left, ignores taps) shows:
     line 1   the browser (user agent: the iOS version is in it)
     line 2   WebM/Opus support, online flag, CPU cores, viewport x DPR
     line 3   which game scripts ran (✓) or did not (✗), by global name
     line 4   requests: done ✓ / still waiting … / failed ✗, and the loader
     then     every JS error, unhandled rejection, failed resource load,
              console.warn/error, and any request waiting longer than 4 s
   It is loaded first (before js/i18n.js) so it sees errors in every later
   script, and written in ES5 so it still runs on an old iOS that cannot
   parse the game's own scripts.  No game text: data and symbols only. */
(function () {
  if (!/[?&]debug\b/.test(location.search)) return;
  var t0 = Date.now();
  var lines = [];
  var head = ['', '', '', ''];
  var panel = null;
  var pending = {}; // id -> { url, start, logged }
  var nextId = 0;
  var ok = 0;
  var failed = 0;

  function secs() {
    return ((Date.now() - t0) / 1000).toFixed(1) + 's ';
  }
  function short(u) {
    u = String(u || '');
    var i = u.indexOf(location.host);
    return i >= 0 ? u.slice(i + location.host.length) : u;
  }
  function draw() {
    if (!panel && document.body) {
      panel = document.createElement('pre');
      panel.setAttribute('aria-hidden', 'true');
      var s = panel.style;
      s.position = 'fixed';
      s.left = '0';
      s.top = '0';
      s.zIndex = '2147483647';
      s.margin = '0';
      s.padding = '4px 6px';
      s.maxWidth = '100vw';
      s.maxHeight = '100vh';
      s.overflow = 'hidden';
      s.font = '10px/1.25 Menlo, monospace';
      s.color = '#0f0';
      s.background = 'rgba(0,0,0,0.78)';
      s.whiteSpace = 'pre-wrap';
      s.wordBreak = 'break-all';
      s.pointerEvents = 'none';
      document.body.appendChild(panel);
    }
    if (panel) panel.textContent = head.join('\n') + '\n' + lines.slice(-40).join('\n');
  }
  function log(msg) {
    lines.push(secs() + msg);
    draw();
  }

  // JS errors (bubbling) and failed <script>/<img>/<link> loads (capture only)
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t !== window && (t.src || t.href)) log('✗ load <' + t.tagName.toLowerCase() + '> ' + short(t.src || t.href));
      else log('✗ ' + (e.message || 'error') + ' @ ' + short(e.filename) + ':' + e.lineno + ':' + e.colno);
    },
    true
  );
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    log('✗ rejection: ' + (r && (r.stack || r.message) ? String(r.message) + ' | ' + String(r.stack || '').split('\n').slice(0, 2).join(' | ') : String(r)));
  });
  ['warn', 'error'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(a && a.message ? a.message : typeof a === 'object' ? safeJson(a) : String(a));
      }
      log((k === 'error' ? '✗ ' : '! ') + parts.join(' '));
      return orig.apply(console, arguments);
    };
  });
  function safeJson(a) {
    try {
      return JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }

  // every fetch: counted when it settles, listed when it hangs
  if (window.fetch) {
    var realFetch = window.fetch;
    window.fetch = function (input) {
      var id = ++nextId;
      var url = short(input && input.url ? input.url : input);
      pending[id] = { url: url, start: Date.now(), logged: false };
      var p = realFetch.apply(this, arguments);
      p.then(
        function (r) {
          // headers are in; the body may still be streaming (assets.js reads it)
          if (!r.ok) log('✗ HTTP ' + r.status + ' ' + url);
          delete pending[id];
          if (r.ok) ok++;
          else failed++;
        },
        function (e) {
          delete pending[id];
          failed++;
          log('✗ fetch ' + url + ' : ' + (e && (e.name + ' ' + e.message)));
        }
      );
      return p;
    };
  }

  var GLOBALS = [
    ['I18n', function () { return window.I18n; }],
    ['gsap', function () { return window.gsap; }],
    ['manifest', function () { return window.ZD_MANIFEST; }],
    ['audio', function () { return window.ZD && ZD.audio; }],
    ['assets', function () { return window.ZD && ZD.assets; }],
    ['sprites', function () { return window.ZD && ZD.sprites; }],
    ['geo', function () { return window.ZD && ZD.geo; }],
    ['scene', function () { return window.ZD && ZD.scene; }],
    ['ui', function () { return window.ZD && ZD.ui; }],
    ['controls', function () { return window.ZD && ZD.controls; }],
    ['intro', function () { return window.ZD && ZD.intro; }],
    ['game', function () { return window.ZD && ZD.game; }],
    ['LOCALES', function () { return window.LOCALES || (window.I18n && I18n.has && I18n.has('appTitle')); }],
    ['VO', function () { return window.VO_MANIFEST; }],
  ];

  function status() {
    var opus = '';
    try {
      opus = new Audio().canPlayType('audio/webm; codecs="opus"') || 'no';
    } catch (e) {
      opus = 'throws';
    }
    head[0] = navigator.userAgent;
    head[1] = 'webm/opus=' + opus + ' online=' + navigator.onLine + ' cores=' + navigator.hardwareConcurrency + ' ' + window.innerWidth + 'x' + window.innerHeight + '@' + window.devicePixelRatio + ' ' + location.protocol;
    head[2] = GLOBALS.map(function (g) {
      var v;
      try {
        v = g[1]();
      } catch (e) {
        v = null;
      }
      return g[0] + (v ? '✓' : '✗');
    }).join(' ');
    var waiting = 0;
    var now = Date.now();
    for (var id in pending) {
      waiting++;
      var p = pending[id];
      if (!p.logged && now - p.start > 4000) {
        p.logged = true;
        log('… waiting >4s ' + p.url);
      }
    }
    var text = document.querySelector('#loader .loader-text');
    var bar = document.querySelector('#loader .bar > div');
    var loader = document.getElementById('loader') ? '"' + (text ? text.textContent : '') + '" bar=' + (bar ? bar.style.transform || '-' : '-') : 'loader gone';
    head[3] = 'fetch ✓' + ok + ' …' + waiting + ' ✗' + failed + ' | ' + loader;
    draw();
  }

  log('debug on');
  document.addEventListener('DOMContentLoaded', function () {
    log('DOMContentLoaded');
  });
  window.addEventListener('load', function () {
    log('window load');
  });
  setInterval(status, 500);
  status();
})();
