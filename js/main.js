/* Boot: load locales, fit the 1920x1080 stage to the viewport, preload, start. */
/* Fit the stage right away (before locales load) so the loading screen -
   which is the welcome screen - shows at its final size from the first frame. */
let paintedScale = 0; // the stage scale the GPU layers were painted at
let repaintTimer = 0;
/* WebKit (Safari, and every browser on iPhone / iPad - they all use it)
   paints each layer at its own CSS size x the screen's pixel ratio and does
   NOT count an ancestor's scale() shrink.  Under a scale(0.36) stage on a 3x
   iPhone that is ~7x the pixels shown: measured 2.1 GB of GPU memory at the
   welcome screen and 3.1 GB in the intro, far over what iOS allows one tab,
   so iOS killed the page and the browser reloaded it, again and again.
   There the stage is shrunk with `zoom` instead: layout itself is at screen
   size, so every layer is painted at the size it is shown (same test:
   0.45 GB welcome, 0.6 GB intro peak, 0.3 GB settled - 5x less).  Its
   own lengths (left/top/width) are zoomed too, hence the divided offsets;
   the identity transform keeps #stage a stacking context and containing
   block, as with scale().  Other engines keep scale(): Chrome's paint scale
   is tuned for it (see "Paint scale" in css/style.css).
   An engine trait, not a capability, so it is read from navigator.vendor
   ('Apple Computer, Inc.' in every WebKit browser, iOS Chrome included). */
const ZOOM_STAGE = /Apple/.test(navigator.vendor || '');
/* Fitting any landscape screen - phone, tablet, desktop, 4:3 to 21:9 -
   with every part of the game on screen and no bare edge:
   - the whole 1920 x 1080 stage fits (contain), so the wall, the answers,
     the bar and every card are always fully visible;
   - it sits on the screen's BOTTOM edge, centred across.  The art ends at
     the ground (y 1080), so a taller screen (16:10, 4:3) shows more sky
     above it - the sky runs on upward (SKY_CAP in js/scene.js) - never a
     cut-off ground below;
   - the scenery is COVER_W wide (2560 less the view swing's drift): a
     screen wider than that (a phone with its browser bar, 21:9) is scaled
     up until the scenery covers it, cropping at most CROP_MAX px of sky
     off the stage's top;
   - the HUD, bar, buttons and popups anchor to the VISIBLE area inside the
     device's safe area (notch, rounded corners, home bar): --vis-* below. */
const COVER_W = 2464;
const CROP_MAX = 90;
/* the device's safe-area insets (CSS px), read from a probe styled with env() */
let safeProbe = null;
function safeInsets() {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.setAttribute('aria-hidden', 'true');
    Object.assign(safeProbe.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      visibility: 'hidden',
      pointerEvents: 'none',
      padding: 'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)',
    });
    document.body.appendChild(safeProbe);
  }
  const cs = getComputedStyle(safeProbe);
  const px = (v) => parseFloat(v) || 0;
  return { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };
}
function fitStage() {
  const stage = document.getElementById('stage');
  const W = window.innerWidth;
  const H = window.innerHeight;
  let s = Math.min(W / 1920, H / 1080);
  s = Math.max(s, Math.min(W / COVER_W, H / (1080 - CROP_MAX)));
  const x0 = (W - 1920 * s) / 2; // the stage's top-left corner on screen (CSS px)
  const y0 = H - 1080 * s;
  if (ZOOM_STAGE) {
    stage.style.zoom = s;
    stage.style.left = `${x0 / s}px`;
    stage.style.top = `${y0 / s}px`;
    stage.style.transform = 'translate(0px, 0px)';
  } else {
    stage.style.left = '0px';
    stage.style.top = '0px';
    stage.style.transformOrigin = '0 0';
    stage.style.transform = `translate(${x0}px, ${y0}px) scale(${s})`;
  }
  /* The camera rig, the sprites and other small movers keep will-change:
     transform, and Chrome keeps such a layer at the scale it was first painted at:
     after the window grows (or a tablet turns) the game would stay blurred,
     after it shrinks it would hold oversized tiles.  Once the size settles,
     every layer is painted again at the new scale (ZD.scene.repaint). */
  if (!paintedScale) paintedScale = s;
  else if (Math.abs(s / paintedScale - 1) > 0.02) {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      paintedScale = s;
      if (ZD.scene && ZD.scene.repaint) ZD.scene.repaint();
    }, 300);
  }
  const root = document.documentElement.style;
  root.setProperty('--s', s);
  // a phone (the stage at under 0.45x): the small corner controls grow
  // ("Phones" in css/style.css)
  stage.classList.toggle('compact', s < 0.45);
  // what the screen shows, in stage px (bottom-aligned: b is always 1080)
  const vis = { l: -x0 / s, t: -y0 / s, r: (W - x0) / s, b: (H - y0) / s };
  /* The UI's edges: the visible area less the safe-area insets.  The HUD,
     timer, bar, RUN / JUMP and the popups anchor to these (css: --vis-*),
     so on a 4:3 tablet the HUD is in the screen's corner, not floating
     where a 16:9 stage would end, and on an iPhone it clears the notch. */
  const ins = safeInsets();
  const safe = { l: vis.l + ins.l / s, t: vis.t + ins.t / s, r: vis.r - ins.r / s, b: vis.b - ins.b / s };
  const r1 = (v) => Math.round(v * 10) / 10 + 'px';
  root.setProperty('--vis-l', r1(safe.l));
  root.setProperty('--vis-t', r1(safe.t));
  root.setProperty('--vis-r', r1(safe.r));
  root.setProperty('--vis-b', r1(safe.b));
  root.setProperty('--vis-w', r1(safe.r - safe.l));
  root.setProperty('--vis-h', r1(safe.b - safe.t));
  /* The screen-filling covers (popup veils, the game-over shade, the
     welcome screen - "Full-screen covers" in the CSS) only cover what this
     screen shows (+ a margin for fx.shake), inside the scenery's design box
     (x -400..2320, y -1300..1180) - the GPU never blurs or blends
     off-screen area.  (The full-screen gradients are small canvases:
     paintWashes in js/scene.js.) */
  const M = 24;
  const l = Math.max(-400, Math.floor(vis.l) - M);
  const t = Math.max(-1300, Math.floor(vis.t) - M);
  root.setProperty('--ov-l', l + 'px');
  root.setProperty('--ov-t', t + 'px');
  root.setProperty('--ov-w', Math.min(2320, Math.ceil(vis.r) + M) - l + 'px');
  root.setProperty('--ov-h', Math.min(1180, Math.ceil(vis.b) + M) - t + 'px');
  // for script that frames the scenery (camera shots, the game-over drift)
  window.ZD = window.ZD || {};
  ZD.view = { s, l: vis.l, t: vis.t, r: vis.r, b: vis.b, safe };
}
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', () => setTimeout(fitStage, 200));
fitStage();

/* The loading screen: bar + one status line.  Downloads take the bar to
   90 %, decoding the first view the last 10 %.  The line shows the
   percentage, and says so when the network is slow or gone, so a learner on
   a phone can see the game is not stuck.  Text waits for the locales. */
const loading = (() => {
  const bar = document.querySelector('#loader .bar > div');
  const text = document.querySelector('#loader .loader-text');
  let shown = '';
  let p = 0;
  let status = '';
  let ready = false;
  let failed = false;
  let queued = false;
  const draw = () => {
    queued = false;
    if (bar) bar.style.transform = `scaleX(${p})`;
    if (!ready || !text) return;
    if (failed) {
      text.textContent = T('appLoadFailed');
      return;
    }
    const pct = Math.floor(p * 100);
    const line = status === 'offline' ? T('appOffline') : T(status === 'slow' ? 'appLoadingSlow' : 'appLoadingPct', { pct });
    if (line !== shown) text.textContent = shown = line;
  };
  return {
    // progress arrives per received chunk; the screen is updated once a frame
    set(fraction, net) {
      p = Math.max(p, fraction); // never runs backwards
      status = net || '';
      if (!queued) {
        queued = true;
        requestAnimationFrame(draw);
      }
    },
    ready() {
      ready = true;
      draw();
    },
    fail() {
      failed = true;
      ready = true;
      draw();
    },
  };
})();

/* Start downloading now, in parallel with the locales - not after them. */
const preloading = ZD.assets.preload((f, net) => loading.set(f * 0.9, net));
preloading.catch(() => {}); // (handled in boot, which may await it later)

async function boot() {
  const stage = document.getElementById('stage');
  try {
    await preloading;
  } catch (e) {
    // Never enter gameplay with a known-missing background or character.
    // The loader remains visible with a useful localized failure message.
    console.error('preload failed', e);
    loading.fail();
    return;
  }
  // The welcome picture is a CSS background by path (so the loading screen
  // has it at once).  If that request of the page's (<link rel=preload> /
  // stylesheet) never finished - a phone can lose one - draw the
  // preloader's downloaded copy instead.  Resource timing lists a request
  // only once it has finished; the preloader's own fetch is left out.
  const welcomePath = new URL(ZD.assets.url('') + ZD.assets.image('roadPersp').src, document.baseURI).href;
  const welcomeShown = performance.getEntriesByName(welcomePath).some((e) => e.initiatorType !== 'fetch' && e.responseEnd > 0);
  const welcomeCopy = ZD.assets.imageUrl('roadPersp');
  if (!welcomeShown && welcomeCopy.startsWith('blob:')) document.documentElement.style.setProperty('--welcome-bg', `url("${welcomeCopy}")`);

  ZD.scene.init(document.getElementById('world'));
  ZD.ui.init(stage);
  ZD.controls.init(stage);
  // Decode only the initial side view now. The front view and later sprite
  // sheets are decoded by camera.prewarm / primeSheets before they appear.
  await ZD.scene.camera.prepareCurrent((f) => loading.set(0.9 + 0.1 * f));
  loading.set(1);
  // AudioContext construction is expensive on some tablets; create the
  // suspended graph under the loading screen, then unlock it on the gesture.
  ZD.audio.prime();

  // the loader is the welcome screen: ZD.intro.title() swaps it for the real
  // one (identical layout) and brings in the play button

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'p') ZD.game.togglePause();
    if (e.key === 'm') {
      ZD.audio.setMuted(!ZD.audio.muted);
      ZD.ui._syncMute();
    }
  });
  // No sound while the learner is away: tab hidden, app backgrounded, or the
  // window lost focus. Hidden also pauses the game.
  const syncActive = () => ZD.audio.setActive(!document.hidden && document.hasFocus());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !ZD.game.paused) ZD.game.togglePause();
    syncActive();
  });
  window.addEventListener('blur', syncActive);
  window.addEventListener('focus', syncActive);
  window.addEventListener('pagehide', () => ZD.audio.setActive(false));
  window.addEventListener('pageshow', syncActive);
  // keep the audio context alive after the first gesture on iOS
  window.addEventListener('pointerdown', () => ZD.audio.unlock(), { once: true });

  ZD.game.run();
}

I18n.load(() => {
  I18n.applyStatic();
  loading.ready();
  boot();
});
