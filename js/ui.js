/* HUD, question prompt, answer options, banners and overlay panels. */
window.ZD = window.ZD || {};

(function () {
  const { el, svg } = ZD.util;
  const M = ZD.motion;
  const T = (k, v) => ZD.T(k, v);

  /* Thumbnail of a piece inside a ghost circle (so a piece always reads as
     "part of a circle"). */
  function pieceThumb(spec, { size = 120, rot = 0, color = '#ffb347', ghost = true } = {}) {
    const r = size * 0.4;
    const s = svg('svg', { viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`, width: size, height: size, class: 'thumb' });
    if (ghost) s.appendChild(svg('circle', { r, fill: 'rgba(255,255,255,0.06)', stroke: 'rgba(255,255,255,0.35)', 'stroke-width': 2, 'stroke-dasharray': '5 5' }));
    const d = ZD.geo.piecePath(spec, 0, 0, r, rot);
    s.appendChild(svg('path', { d, fill: color, stroke: '#5b2a0e', 'stroke-width': 3, 'stroke-linejoin': 'round' }));
    if (ghost) s.appendChild(svg('circle', { r: 3, fill: '#fff', opacity: 0.8 }));
    return s;
  }

  /* A circle for the review after a miss (ui.reviewCard), drawn the way
     the lesson draws it (circle-skill-1): a lavender disc in an orange rim
     with a pink centre, navy points where lines meet the rim; a minor
     region pink, a major one violet; a minor arc sky blue, a major arc
     violet - a thick line on the rim.
     Returns { el, play }: play(tl, at) adds the circle's explanation to the
     card's timeline at label `at` and returns how long it runs (ms):
       1. the part's two points land on the rim
       2. its straight edges draw - two radii from the centre for a sector,
          a chord for a segment, none for an arc
       3. the part itself fills in (an arc draws along the rim) as the rim
          steps back */
  const RV = {
    disc: '#d3d1fa',
    rim: '#fb640c',
    edge: '#3e1a8c',
    point: '#25209b',
    centre: '#f51b88',
    minor: { fill: '#ff8fa3', ink: '#d6245b', arc: '#38b6f5' },
    major: { fill: '#b48cf2', ink: '#6a2bd6', arc: '#8a5cf0' },
  };
  function reviewCircle(spec, size = 400) {
    const geo = ZD.geo;
    const n = geo.normalize(spec);
    const h = size / 2;
    const r = h - 14; // room for the points and a thick arc on the rim
    const tone = n.size === 'major' ? RV.major : RV.minor;
    const f = (v) => Math.round(v * 100) / 100;
    const p0 = geo.polar(0, 0, r, n.start);
    const p1 = geo.polar(0, 0, r, n.start + n.sweep);
    // a line that draws itself: dashed by its own length so the dash
    // offset can run it in
    const drawn = (d, len, attrs) => {
      const L = f(len + 2);
      return svg('path', Object.assign({ d, fill: 'none', 'stroke-dasharray': `${L} ${L}`, 'stroke-dashoffset': L }, attrs));
    };
    const edge = (a, b) => drawn(`M ${f(a.x)} ${f(a.y)} L ${f(b.x)} ${f(b.y)}`, Math.hypot(b.x - a.x, b.y - a.y), { stroke: RV.edge, 'stroke-width': 5, 'stroke-linecap': 'round' });
    const dot = (p) => svg('circle', { cx: f(p.x), cy: f(p.y), r: 8, fill: RV.point, stroke: '#ffffff', 'stroke-width': 3 });

    const s = svg('svg', { viewBox: `${-h} ${-h} ${size} ${size}`, width: size, height: size, class: 'review-svg', 'aria-hidden': 'true' });
    const rim = svg('circle', { r, fill: 'none', stroke: RV.rim, 'stroke-width': 5 });
    const arc = n.type === 'arc';
    const part = arc
      ? drawn(geo.arcStroke(0, 0, r, n.start, n.sweep), (r * Math.PI * n.sweep) / 180, { stroke: tone.arc, 'stroke-width': 14, 'stroke-linecap': 'butt' })
      : svg('path', { d: geo.piecePath(n, 0, 0, r), fill: tone.fill, stroke: tone.ink, 'stroke-width': 4, 'stroke-linejoin': 'round', opacity: 0 });
    const O = { x: 0, y: 0 };
    const edges = n.type === 'sector' ? [edge(O, p0), edge(O, p1)] : n.type === 'segment' ? [edge(p0, p1)] : [];
    const dots = [dot(p0), dot(p1)];
    s.append(
      svg('circle', { r, fill: RV.disc }),
      rim,
      part,
      ...edges,
      svg('circle', { r: 7, fill: RV.centre, stroke: '#ffffff', 'stroke-width': 3 }),
      ...dots
    );

    const play = (tl, at) => {
      const t = (ms) => ZD.scene.D(ms) / 1000;
      let o = 0; // ms after `at`
      const pos = () => `${at}+=${t(o)}`;
      // 1. the two points
      tl.call(() => ZD.audio.play('pop'), null, pos());
      tl.fromTo(dots, { opacity: 0, scale: 0, transformOrigin: '50% 50%' }, { opacity: 1, scale: 1, duration: t(300), ease: M.EASE.POP, stagger: t(110) }, pos());
      o += 460;
      // 2. the straight edges (the two radii together)
      if (edges.length) {
        tl.to(edges, { strokeDashoffset: 0, duration: t(560), ease: M.PHYS.DECEL }, pos());
        o += 640;
      }
      // 3. the part, as the rim steps back
      tl.to(rim, { opacity: 0.6, duration: t(500), ease: M.EASE.OUT }, pos());
      if (arc) {
        tl.to(part, { strokeDashoffset: 0, duration: t(820), ease: M.PHYS.DECEL }, pos());
        o += 820;
      } else {
        tl.to(part, { opacity: 1, duration: t(500), ease: M.EASE.OUT }, pos());
        o += 500;
      }
      return o;
    };
    return { el: s, play };
  }

  const CHECK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M7 12.4l3.3 3.3L17.2 8.8" fill="none" stroke="#2f9c45" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /* the hint card's label icon: a light bulb */
  const BULB_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2.5a6.8 6.8 0 0 0-4 12.3c.6.5 1 1.2 1 2V18h6v-1.2c0-.8.4-1.5 1-2a6.8 6.8 0 0 0-4-12.3z" fill="#ffd23f" stroke="#7a4a00" stroke-width="1.6" stroke-linejoin="round"/><path d="M9.5 20.5h5" stroke="#7a4a00" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const CROSS_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#fff"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" fill="none" stroke="#d61f44" stroke-width="2.8" stroke-linecap="round"/></svg>';

  const ui = {
    pieceThumb,
    answerBtns: null,
    init(root) {
      this.root = root;
      this.hud = root.querySelector('#hud');
      this.optionsEl = root.querySelector('#options');
      this.bannerEl = root.querySelector('#banner');
      this._buildHud();
      this._buildBar();
    },

    /* ---------------- HUD ---------------- */
    _buildHud() {
      const h = this.hud;
      h.innerHTML = '';
      // profile picture (circle-game-art/images/boy/profile.png via the asset pipeline)
      const portrait = el('div', { class: 'portrait', style: { backgroundImage: `url("${ZD.assets.imageUrl('profile')}")` } });
      // stage chip: "Wall 2/6" (set per wall by setStage)
      this.stageEl = el('div', { class: 'hud-stage' });
      const left = el('div', { class: 'hud-left' }, [portrait, this.stageEl]);

      this.muteBtn = el('button', { class: 'icon-btn', 'aria-label': T('hudMute'), onClick: () => {
        ZD.audio.setMuted(!ZD.audio.muted);
        if (ZD.audio.muted) I18n.stop(); // (a voice clip is not on the effects bus)
        this._syncMute();
        ZD.audio.play('click');
      } });
      this.pauseBtn = el('button', { class: 'icon-btn pause', 'aria-label': T('hudPause'), html: '<span></span><span></span>', onClick: () => ZD.game && ZD.game.togglePause() });
      const right = el('div', { class: 'hud-right' }, [this.muteBtn, this.pauseBtn]);
      h.append(left, right);
      this._syncMute();
    },
    _syncMute() {
      this.muteBtn.classList.toggle('muted', ZD.audio.muted);
      this.muteBtn.innerHTML = ZD.audio.muted
        ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';
    },
    showHud(v) {
      this.hud.classList.toggle('visible', v);
    },
    /* Current / total stage in the top-left chip; pops when the stage changes. */
    setStage(n, total) {
      const text = T('hudStage', { n, total });
      if (this.stageEl.textContent === text) return;
      this.stageEl.textContent = text;
      M.stop(this.stageEl);
      M.fromTo(this.stageEl, { scale: 1.25 }, { scale: 1, duration: M.DUR.SLOW, ease: M.EASE.POP });
    },

    /* ---------------- answer panel ----------------
       A side panel (a column of four text pills) to the right of the wall,
       clear of the window and the hero.  Each question offers four pieces
       chosen by rule (ZD.geo.options: the right one, its size twin, a type
       twin and a wild card) in random order, so neither the set nor the
       position gives the answer away.  Buttons carry only the piece id;
       `order` keeps their top-to-bottom order. */
    _buildPanel() {
      const box = this.optionsEl;
      box.innerHTML = '';
      box.className = 'answer-panel';
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', T('gridTitle'));
      this.listEl = el('div', { class: 'answer-list' });
      box.appendChild(this.listEl);
      this._panelBuilt = true;
    },
    /* The panel box spans from the wall's right edge to the stage's right
       edge, top to bottom of the wall as framed while asking (the 'focus'
       shot); CSS centres the pills in it both ways.  Stage px, so on a
       16:9 screen the pills sit midway between wall and screen edge, and
       on wider screens (scenery past the stage edge) they stay by the wall. */
    _placePanel() {
      const front = ZD.scene.front;
      if (!front || !front.wallInShot) return;
      const w = front.wallInShot('focus');
      const left = Math.round(w.x + w.w);
      Object.assign(this.optionsEl.style, {
        left: left + 'px',
        width: ZD.scene.STAGE_W - left + 'px',
        top: Math.round(w.y) + 'px',
        height: Math.round(w.h) + 'px',
      });
    },
    _fillOptions(targetId) {
      this.order = ZD.geo.options(targetId);
      this.listEl.innerHTML = '';
      this.answerBtns = {};
      this.order.forEach((id) => {
        const label = T(ZD.geo.labelKey(id));
        const b = el('button', { class: 'answer', dataset: { piece: id }, 'aria-label': label }, [el('span', { class: 'answer-label', text: label })]);
        b.addEventListener('click', () => this._pick(id));
        this.listEl.appendChild(b);
        this.answerBtns[id] = b;
      });
    },
    _pick(id) {
      if (!this._asking) return;
      const res = this._asking;
      this._asking = null;
      ZD.audio.play('select');
      this.answerBtns[id].classList.add('selected');
      this.optionsEl.classList.add('locked');
      res(id);
    },
    /* Show four fresh options for `targetId` and resolve with the tapped
       piece id. */
    ask(targetId) {
      if (!this._panelBuilt) this._buildPanel();
      this._placePanel();
      const box = this.optionsEl;
      const wasVisible = box.classList.contains('visible');
      if (this.answerBtns) M.stop(Object.values(this.answerBtns));
      this._fillOptions(targetId);
      box.classList.remove('locked');
      const pills = Object.values(this.answerBtns);
      if (!wasVisible) {
        box.classList.add('visible');
        M.stop(box);
        M.enter(box, { x: 80 });
      }
      // once in, the pills hand their look back to the stylesheet (hover,
      // press, picked, dimmed when locked)
      M.enter(pills, { x: 40 }, { delay: wasVisible ? 0 : M.DUR.INSTANT, stagger: M.STAGGER.UI, clearProps: 'transform,opacity' });
      return new Promise((res) => (this._asking = res));
    },
    /* Stop accepting taps (time out / abort). */
    endAsk() {
      this._asking = null;
      this.optionsEl.classList.add('locked');
    },
    markAnswer(id, state) {
      const b = this.answerBtns && this.answerBtns[id];
      if (!b) return;
      b.classList.add(state);
      if (state === 'reveal') M.pulse(b, 1.08, { duration: M.DUR.SLOW, clearProps: 'transform' });
    },
    hideGrid(instant = false) {
      const box = this.optionsEl;
      this._asking = null;
      if (!box.classList.contains('visible')) return Promise.resolve();
      const pills = Object.values(this.answerBtns || {});
      M.stop([box, ...pills]);
      if (instant || !this._panelBuilt) {
        box.classList.remove('visible');
        return Promise.resolve();
      }
      return M.exit(box, { x: 80 }).then(() => box.classList.remove('visible'));
    },

    /* ---------------- zombie timer meter ----------------
       Top strip shown while a timed question is open: the wall zombie's
       face on the left, the small brick wall on the right, a plain red line
       joining them.  The face closes in on the wall as time runs out and the
       line shrinks with it.  game.js drives it from the climbing zombie's
       own tween (front.zombieClimb onProgress), so the meter, the climb and
       the time-out share one clock and pause together.  Per frame only
       transform / opacity change. */
    TIMER: { W: 780, H: 150, FACE_H: 112, WALL_H: 132, BRICKS: 0.2, WALL_UP: 18, LINE_H: 14 }, // WALL_UP: wall sits this much above the line
    _buildTimer() {
      const box = this.root.querySelector('#timer');
      box.innerHTML = '';
      box.setAttribute('role', 'progressbar');
      box.setAttribute('aria-label', T('timerLabel'));
      box.style.width = this.TIMER.W + 'px';
      box.style.height = this.TIMER.H + 'px';
      this.tLine = el('div', { class: 'timer-line' });
      this.tFace = el('div', { class: 'timer-face' });
      this.tFaceImg = el('img', { class: 'timer-face-img', alt: '', draggable: 'false' });
      this.tFace.appendChild(this.tFaceImg);
      this.tWall = el('img', { class: 'timer-wall', alt: '', draggable: 'false', src: ZD.assets.imageUrl('timerWall') });
      box.append(this.tLine, this.tWall, this.tFace);
      this.timerEl = box;
    },
    /* Show the meter for a `seconds` countdown with zombie skin `skin`. */
    timerShow(skin, seconds) {
      if (!this.timerEl) this._buildTimer();
      const C = this.TIMER;
      const box = this.timerEl;
      const key = 'timerFace' + (((skin || 0) % 2) + 2) % 2;
      const face = ZD.assets.image(key);
      const faceW = Math.round((face.w * C.FACE_H) / face.h);
      const wallArt = ZD.assets.image('timerWall');
      const wallW = Math.round((wallArt.w * C.WALL_H) / wallArt.h);
      const wallX = C.W - wallW;
      const mid = C.H / 2;
      Object.assign(this.tFaceImg.style, { width: faceW + 'px', height: C.FACE_H + 'px' });
      this.tFaceImg.src = ZD.assets.imageUrl(key);
      Object.assign(this.tFace.style, { width: faceW + 'px', height: C.FACE_H + 'px', top: mid - C.FACE_H / 2 + 'px' });
      Object.assign(this.tWall.style, { width: wallW + 'px', height: C.WALL_H + 'px', top: mid - C.WALL_H / 2 - C.WALL_UP + 'px' });
      // the line runs from the face's centre to just under the wall's bricks
      const lineL = faceW / 2;
      const lineR = wallX + wallW * (C.BRICKS + 0.12);
      Object.assign(this.tLine.style, { left: lineL + 'px', width: lineR - lineL + 'px', height: C.LINE_H + 'px', top: mid - C.LINE_H / 2 + 'px' });
      // at q = 1 the face presses into the bricks
      this._t = { faceW, lineL, lineR, travel: wallX + wallW * C.BRICKS - faceW * 0.82, seconds, left: null };
      box.classList.remove('danger');
      this.timerSet(0, 0);
      M.stop([box, this.tWall, this.tFaceImg]);
      M.clear([this.tWall, this.tFaceImg], 'transform');
      box.classList.add('visible');
      M.enter(box, { y: -40 });
    },
    /* q 0..1 = how far the zombie has come; hop 0..1 = its stride bounce. */
    timerSet(q, hop) {
      const t = this._t;
      if (!t) return;
      const x = q * t.travel;
      this.tFace.style.transform = `translate3d(${x.toFixed(1)}px, ${(-hop * 10).toFixed(1)}px, 0) rotate(${(hop * 7 - 2).toFixed(1)}deg)`;
      const len = t.lineR - t.lineL;
      this.tLine.style.transform = `scaleX(${Math.max(0, (len - x) / len).toFixed(4)})`;
      this.timerEl.classList.toggle('danger', q > 0.7);
      const left = Math.ceil(t.seconds * (1 - q));
      if (left !== t.left) {
        t.left = left;
        this.timerEl.setAttribute('aria-valuenow', String(left));
        this.timerEl.setAttribute('aria-valuetext', left === 1 ? T('timerLeftOne') : T('timerLeft', { s: left }));
      }
    },
    /* Time up: the face slams the wall, the wall shakes, then the meter goes. */
    timerHit() {
      if (!this._t) return Promise.resolve();
      this.timerSet(1, 0);
      M.stop([this.tWall, this.tFaceImg]);
      // the face squashes on the bricks and springs back; the wall rattles
      M.fromTo(this.tFaceImg, { scaleX: 1.25, scaleY: 0.8 }, { scaleX: 1, scaleY: 1, duration: M.DUR.SLOW, ease: M.EASE.POP });
      return M.shake(this.tWall, { x: [0, 12, -10, 7, -4, 0], rotation: [0, 3, -2, 1, 0, 0] }, { duration: M.DUR.REVEAL }).then(() => this.timerHide());
    },
    timerHide(instant = false) {
      const box = this.timerEl;
      if (!box || !box.classList.contains('visible')) return Promise.resolve();
      this._t = null;
      M.stop(box);
      const done = () => box.classList.remove('visible', 'danger');
      if (instant) return Promise.resolve(done());
      return M.exit(box, { y: -30 }).then(done);
    },

    /* ---------------- instruction bar ----------------
       Every line (the intro story, each step of a wall, rule reviews)
       appears in ONE bar at the bottom: circle-game-art/images/banner.png,
       stretched as a 9-slice (left cap = portrait socket, right cap =
       stripes; caps measured by tools/build-assets.py build_banner).  It sits
       right of the hero and under the answer panel.  The hero's face looks
       out of the socket. */
    _buildBar() {
      const b = this.bannerEl;
      const art = ZD.assets.image('banner');
      const H = 160;
      const k = H / art.h;
      const capL = Math.round(art.capL * k);
      const capR = Math.round(art.capR * k);
      b.className = 'banner msgbar';
      b.innerHTML = '';
      b.style.height = H + 'px';
      b.style.borderWidth = `0 ${capR}px 0 ${capL}px`;
      b.style.borderImage = `url("${ZD.assets.imageUrl('banner')}") 0 ${art.capR} 0 ${art.capL} fill / 0 ${capR}px 0 ${capL}px stretch`;
      // portrait in the socket (positioned in border-box px: the left cap is a border)
      const r = art.socket.r * k;
      const face = el('div', { class: 'msgbar-face', style: { left: art.socket.x * k - r - capL + 'px', top: art.socket.y * k - r + 'px', width: r * 2 + 'px', height: r * 2 + 'px' } });
      face.style.backgroundImage = `url("${ZD.assets.imageUrl('profile')}")`;
      // every line sits in the same grid cell, so the outgoing line fades
      // out exactly where the incoming one rises in (no jump, no blank frame)
      this.barText = el('div', { class: 'msgbar-text' });
      b.append(face, this.barText);
      this._queue = []; // lines waiting to appear
      this._busy = false; // the line on screen is still being read
      this._lineId = 0;
    },

    /* ---------------- instruction bar: one sentence at a time ----------
       guide(key) is the only way text reaches the bar.  Each call shows ONE
       sentence (an i18n key), reads it aloud, and resolves true once the
       learner has had time to read it: its reading time has passed AND the
       read-aloud has finished (it resolves false if it was dropped before
       it appeared).  Lines queue in order: a line waits until the one on
       screen has been read, so lines never flash past.  Lines are short
       and never wrap: one line in the bar (_fitLine shrinks one that is too
       long, e.g. in another language).
         prompt: true   an action prompt (RUN, JUMP...) - it can go out of date
         replace: true  drops the waiting prompts and takes their place
         now: true      drops the waiting lines and shows at once (urgent)
       kind: info | alert | ask | good | bad.  *word* in the text marks a
       key word (highlighted).  Motion: transform / opacity only. */
    guide(key, { vars, kind = 'info', now = false, replace = false, prompt = false, speak = true } = {}) {
      return new Promise((resolve) => {
        if (now) this._dropWaiting();
        else if (replace) this._dropWaiting((e) => e.prompt);
        const entry = { key, vars, kind, speak, prompt, resolve };
        if (now) this._play(entry);
        else {
          this._queue.push(entry);
          this._pump();
        }
      });
    },
    _dropWaiting(which = () => true) {
      this._queue = this._queue.filter((e) => {
        if (!which(e)) return true;
        e.resolve(false);
        return false;
      });
    },
    _pump() {
      if (this._busy || !this._queue.length) return;
      this._play(this._queue.shift());
    },
    _play(entry) {
      const id = ++this._lineId;
      this._busy = true;
      const text = T(entry.key, entry.vars);
      // with a recorded clip the words wait and come up as they are spoken
      const timing = entry.speak ? I18n.timing(entry.key, entry.vars) : null;
      const shown = this._showLine(text, entry.kind, !!timing);
      const read = this._readMs(text);
      const reveal = (synced) => timing && this._revealWords(shown, synced ? timing : null);
      const spoken = entry.speak ? I18n.say(entry.key, entry.vars, reveal) : Promise.resolve();
      if (timing) spoken.then(() => reveal(false)); // (never left hidden)
      // (a read-aloud that never reports its end can hold a line only so long)
      Promise.all([ZD.clock.wait(read), Promise.race([spoken, ZD.clock.wait(read + 5000)])]).then(() => {
        entry.resolve(true);
        if (id !== this._lineId) return; // a newer line (or a reset) took over
        this._busy = false;
        this._pump();
      });
    },
    /* Time to read a line: a beat to notice it plus ~0.3 s a word. */
    _readMs(text) {
      const words = text.replace(/\*/g, '').trim().split(/\s+/).length;
      return Math.max(1600, 800 + words * 300);
    },
    /* A line wider than the bar is set smaller (once, before it shows -
       never animated), so it still fits on one line. */
    _fitLine(line) {
      const box = this.barText;
      const cs = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = line.scrollWidth;
      if (room > 0 && w > room) {
        const size = parseFloat(getComputedStyle(line).fontSize);
        line.style.fontSize = Math.floor(size * (room / w) * 0.98) + 'px';
      }
    },
    /* Words as inline-blocks so each can rise in on its own; *...* = key word. */
    _lineNode(text, kind) {
      const line = el('div', { class: 'msgbar-line ' + kind });
      const words = [];
      let off = 0; // where each word starts in the plain text (no *marks*): the clip timings use it
      text.split(/(\*[^*]+\*)/).forEach((part) => {
        if (!part) return;
        const hl = part.length > 2 && part[0] === '*' && part[part.length - 1] === '*';
        (hl ? part.slice(1, -1) : part).split(/(\s+)/).forEach((w) => {
          if (!w) return;
          const at = off;
          off += w.length;
          if (/^\s+$/.test(w)) return line.appendChild(document.createTextNode(' '));
          const span = el('span', { class: 'w' + (hl ? ' hl' : ''), text: w });
          span._off = at;
          // hidden from the very first frame (no flash before the tween starts)
          span.style.opacity = '0';
          span.style.transform = 'translateY(18px)'; // (= the tween's start: _showLine)
          line.appendChild(span);
          words.push(span);
        });
      });
      return { line, words };
    },
    /* held: the words stay hidden until _revealWords (voice-synced). */
    _showLine(text, kind, held = false) {
      const b = this.bannerEl;
      const box = this.barText;
      const { line, words } = this._lineNode(text, kind);
      const barUp = b.classList.contains('visible') && !this._barHiding;
      this._barHiding = false;
      // the line on screen leaves: up and out, quickly (ease-in)
      const old = Array.from(box.children).filter((n) => !n.classList.contains('leaving'));
      old.forEach((n) => {
        n.classList.add('leaving');
        M.stop(n.querySelectorAll('.w'));
        M.exit(n, { y: -14 }, { onComplete: () => n.remove() });
      });
      box.appendChild(line);
      // cross-fade: the new line starts halfway through the old one's exit
      let delay = old.length ? M.DUR.FAST / 2 : 0;
      if (!barUp) {
        M.stop(b);
        b.classList.add('visible');
        // hidden before it is shown, so it can never pop up for a frame
        M.set(b, { y: 60, opacity: 0 });
      }
      this._fitLine(line); // (the bar is laid out now: measure the line)
      if (!barUp) {
        M.enter(b, { y: 60 });
        delay = M.DUR.NORMAL / 2; // the words rise as the bar settles
      }
      const shown = { line, words, delay, revealed: false };
      if (!held) this._revealWords(shown, null);
      return shown;
    },
    /* The words rise in (ease-out).  With timing ([[charOffset, sec]] from
       the clip, called as it starts to sound) each word comes up just as it
       is spoken; without it the line comes up word by word in about 0.6 s
       whatever its length. */
    _revealWords(shown, timing) {
      if (shown.revealed || shown.line.classList.contains('leaving')) return;
      shown.revealed = true;
      const { words } = shown;
      if (!timing) {
        M.enter(words, { y: 18 }, { delay: shown.delay, stagger: Math.max(0.018, Math.min(0.045, 0.6 / words.length)) });
        return;
      }
      // a word starts to rise a moment before it is heard, so it is up as it is said
      const LEAD = 0.05;
      const at = words.map((w) => {
        let t = 0;
        for (const [o, s] of timing) if (o <= w._off) t = s;
        return Math.max(0, t - LEAD);
      });
      M.enter(words, { y: 18 }, { stagger: (i) => at[i] });
    },
    /* Slide the bar away (the line stays in it until it is shown again). */
    hideBanner() {
      const b = this.bannerEl;
      // drop the lines still waiting; the next line shows at once
      this._dropWaiting();
      this._lineId++;
      this._busy = false;
      if (!b.classList.contains('visible') || this._barHiding) return Promise.resolve();
      this._barHiding = true;
      M.stop(b);
      const done = () => {
        if (!this._barHiding) return; // a new line arrived meanwhile
        this._barHiding = false;
        b.classList.remove('visible');
        this.barText.innerHTML = '';
      };
      return M.exit(b, { y: 40 }).then(done);
    },
    /* Instant reset (restart / home): no bar, no queued lines. */
    clearGuide() {
      this._dropWaiting();
      this._lineId++;
      this._busy = false;
      this._barHiding = false;
      M.stop(this.bannerEl);
      this.bannerEl.classList.remove('visible');
      this.barText.innerHTML = '';
    },

    /* ---------------- generic overlay panel ---------------- */
    /* buttons: [{label, cls, onClick}] - resolves with the clicked index. */
    panel({ id, title, html, buttons = [], cls = '' }) {
      const ov = document.getElementById(id);
      ov.innerHTML = '';
      ov.className = 'overlay ' + cls;
      const p = el('div', { class: 'panel' });
      if (title) p.appendChild(el('h2', { class: 'panel-title', text: title }));
      const body = el('div', { class: 'panel-body' });
      if (typeof html === 'string') body.innerHTML = html;
      else if (html) body.appendChild(html);
      p.appendChild(body);
      const row = el('div', { class: 'btn-row' });
      const result = new Promise((resolve) => {
        buttons.forEach((b, i) => {
          row.appendChild(
            el('button', { class: 'btn ' + (b.cls || 'primary'), text: b.label, onClick: () => {
              ZD.audio.play('click');
              b.onClick && b.onClick();
              if (!b.keepOpen) ui.closePanel(id);
              resolve(i);
            } })
          );
        });
      });
      if (buttons.length) p.appendChild(row);
      ov.appendChild(p);
      ov.classList.add('visible');
      M.pop(p, { scale: 0.85 });
      return { el: ov, panel: p, body, result };
    },
    closePanel(id) {
      const ov = document.getElementById(id);
      const p = ov.querySelector('.panel');
      if (!p) {
        ov.classList.remove('visible');
        return Promise.resolve();
      }
      return M.exit(p, { scale: 0.9 }).then(() => {
        ov.classList.remove('visible');
        ov.innerHTML = '';
      });
    },

    /* The game-over screen's replay button: the retry arrow + `label`
       (Try again, after every miss), under the hint or review card. */
    replayButton(label) {
      return el('button', { class: 'btn primary review-btn' }, [
        el('span', { class: 'go-retry-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M20.5 3.5v5h-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
        el('span', { text: label }),
      ]);
    },

    /* "Look again" - the review after a miss (LXD P8), shown on the
       game-over screen once the sign has made way.  target: the gap's spec;
       chosen: the tapped piece id, or null when time ran out; thrown: the
       chosen piece as it flew (game.wrongPiece).  A game panel with the
       circles drawn the way the lesson (circle-skill-1) draws them: the part that fitted
       the gap (left, a green tick) and the piece that was picked (right, a
       red cross), each explained in turn on its circle (reviewCircle: its
       points, its straight edges, then the part fills in), then named, with
       its one-line rule under it, read aloud.  The other circle is dimmed
       meanwhile; at the end both are lit.  Only then does the Try again
       button come up - below the card, outside it.  A tap on the card skips
       to the end of the explanation.
       Returns { el, button, explain, done }: explain() plays the
       explanation (call it once the card is on screen) and resolves as the
       button shows; done resolves on the button's tap. */
    reviewCard({ target, chosen, thrown, button }) {
      const geo = ZD.geo;
      const hidden = { opacity: 0 };
      const item = (spec, id, right, i) => {
        const c = reviewCircle(spec);
        const chip = el('div', { class: 'review-chip ' + (right ? 'right' : 'wrong'), style: hidden }, [
          el('span', { class: 'review-chip-ico', 'aria-hidden': 'true', html: right ? CHECK_ICON : CROSS_ICON }),
          el('span', { text: T(geo.labelKey(id)) }),
        ]);
        const key = geo.ruleKey(id);
        const rule = el('p', { class: 'review-rule', text: T(key), style: hidden });
        // (the second circle waits dimmed for its turn)
        const node = el('div', { class: 'review-item ' + (right ? 'needed' : 'chosen'), style: i ? { opacity: 0.35 } : {} }, [c.el, chip, rule]);
        return { el: node, chip, rule, key, play: c.play };
      };
      const parts = [item(target, geo.idOf(target), true, 0)];
      if (chosen && thrown) parts.push(item(thrown, chosen, false, 1));
      // no title on the card (the circles say it); reviewTitle still names
      // the dialog for a screen reader
      const card = el('div', { class: 'review-card', role: 'dialog', 'aria-label': T('reviewTitle') }, [
        el('div', { class: 'review-pair' }, parts.map((p) => p.el)),
      ]);
      const btn = ui.replayButton(button);
      // below the card; it keeps its place (no jump) but stays hidden until
      // the explanation has ended
      const row = el('div', { class: 'review-actions waiting' }, [btn]);
      const wrap = el('div', { class: 'review' }, [card, row]);

      let tl = null;
      const explain = () => new Promise((res) => {
        const t = (ms) => ZD.scene.D(ms) / 1000;
        const fade = (targets, opacity, at) => tl.to(targets, { opacity, duration: M.DUR.SLOW, ease: M.EASE.OUT }, at);
        let shown = false;
        const finish = () => {
          if (shown) return;
          shown = true;
          card.removeEventListener('pointerdown', skip);
          row.classList.remove('waiting');
          ZD.audio.play('pop');
          M.pop(btn, { y: 18, scale: 0.85 }).then(() => M.clear(btn)); // (inline transform would block :hover / :active)
          res();
        };
        const skip = () => {
          tl.progress(1, true); // to the last frame, no sounds on the way
          I18n.stop();
          finish();
        };
        // built now the card is on screen (the SVG origins need layout)
        tl = M.timeline({ paused: true, onComplete: finish });
        parts.forEach((p, i) => {
          const at = 'part' + i;
          // the next circle starts once the line before it has been read
          tl.addLabel(at, i ? `+=${t(1900)}` : t(300));
          if (i) {
            fade(parts.filter((q) => q !== p).map((q) => q.el), 0.35, at);
            fade(p.el, 1, at);
          }
          const after = `${at}+=${t(p.play(tl, at) + 150)}`;
          // named, then its rule, read aloud
          tl.fromTo(p.chip, { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: t(320), ease: M.EASE.POP, immediateRender: false }, after);
          tl.call(() => I18n.say(p.key), null, after);
          tl.fromTo(p.rule, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: t(380), ease: M.EASE.OUT, immediateRender: false }, `${after}+=${t(140)}`);
        });
        // both lit side by side, a beat to compare, then the button
        if (parts.length > 1) fade(parts.map((p) => p.el), 1, `+=${t(500)}`);
        tl.to({}, { duration: t(1300) });
        card.addEventListener('pointerdown', skip);
        tl.play();
      });
      const done = new Promise((res) => btn.addEventListener('click', () => {
        ZD.audio.play('click');
        I18n.stop();
        if (tl) tl.kill();
        res();
      }, { once: true }));
      return { el: wrap, button: btn, explain, done };
    },

    /* The hint after a miss that still has tries left (LXD: never say the
       answer then - a short explanation, no figure, then Try again).
       keys: the hint's two lines (what the picked part needs, then what to
       check in the gap), each read aloud as it rises in.  A text-only game
       panel with a HINT label; the Try again button comes up below it once
       both lines have been read.  A tap on the card skips the reading.
       Returns { el, button, explain, done } like reviewCard. */
    hintCard({ keys, button }) {
      // each line is word spans (as in the bar), so the words can come up
      // just as the voice says them; *...* = key word
      const lines = keys.map((key) => {
        const { line, words } = this._lineNode(T(key), 'hint');
        line.className = 'hint-line';
        return { key, el: line, words };
      });
      const card = el('div', { class: 'review-card hint-card', role: 'dialog', 'aria-label': T('titleHint') }, [
        el('div', { class: 'hint-label' }, [
          el('span', { class: 'hint-ico', 'aria-hidden': 'true', html: BULB_ICON }),
          el('span', { text: T('titleHint') }),
        ]),
        ...lines.map((l) => l.el),
      ]);
      const btn = ui.replayButton(button);
      const row = el('div', { class: 'review-actions waiting' }, [btn]);
      const wrap = el('div', { class: 'review hint' }, [card, row]);

      let skipped = false;
      let skip = () => {};
      const explain = () => new Promise((res) => {
        let shown = false;
        const finish = () => {
          if (shown) return;
          shown = true;
          card.removeEventListener('pointerdown', skip);
          row.classList.remove('waiting');
          ZD.audio.play('pop');
          M.pop(btn, { y: 18, scale: 0.85 }).then(() => M.clear(btn)); // (inline transform would block :hover / :active)
          res();
        };
        skip = () => {
          skipped = true;
          I18n.stop();
          lines.forEach((l) => {
            M.stop(l.words);
            M.set(l.words, { opacity: 1, y: 0 });
          });
          finish();
        };
        card.addEventListener('pointerdown', skip);
        // each word rises in (ease-out) as it is spoken (word timings of the
        // clip), or word by word without a clip; the next line waits until
        // this one has been read (or a reading time, without a voice)
        (async () => {
          await ZD.clock.wait(ZD.scene.D(250));
          for (const l of lines) {
            if (skipped) return;
            const shown = { line: l.el, words: l.words, delay: 0, revealed: false };
            const timing = I18n.timing(l.key);
            const read = ZD.scene.D(900 + T(l.key).split(/\s+/).length * 280);
            const spoken = I18n.say(l.key, undefined, (synced) => !skipped && this._revealWords(shown, synced ? timing : null));
            spoken.then(() => !skipped && this._revealWords(shown, null)); // (never left hidden)
            // (a read-aloud that never reports its end holds a line only so long)
            await Promise.all([ZD.clock.wait(read), Promise.race([spoken, ZD.clock.wait(read + 5000)])]);
          }
          if (!skipped) await ZD.clock.wait(ZD.scene.D(300));
          finish();
        })();
      });
      const done = new Promise((res) => btn.addEventListener('click', () => {
        ZD.audio.play('click');
        skipped = true;
        I18n.stop();
        M.stop(lines.flatMap((l) => l.words));
        res();
      }, { once: true }));
      return { el: wrap, button: btn, explain, done };
    },

    /* Pause menu: just the title and Resume.  Sound is switched from the
       speaker icon in the HUD; read-aloud and the zombie timer are always on. */
    pauseMenu(onResume) {
      return this.panel({
        id: 'pause',
        title: T('pauseTitle'),
        cls: 'pause',
        buttons: [{ label: T('btnResume'), cls: 'primary', onClick: onResume }],
      });
    },
  };

  ZD.ui = ui;
})();
