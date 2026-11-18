/* game-i18n: key-based text + voice-over.
   ------------------------------------------------------------------
   Text   : T('key', {vars})      HTML: <span data-i18n="key">
   Voice  : I18n.say('key', vars) -> plays assets/VO-<LANG>/<clip>.mp3 when the
            clip is listed in assets/VO-<LANG>/manifest.js, otherwise speaks
            T(key) with the browser speech engine (captions are always shown).
            A line with {vars} has one clip per value: <key>_<tag>[_<tag>]
            (numbers as-is, a piece name as its id: guideCorrect_MinorSector).
            I18n.timing() gives each word's start time in the clip, so the
            caption bar can show every word as it is spoken.
            Clips are cut from one recording by tools/split-vo.py (local tool,
            output committed; script order: tools/build-vo.py --list).
   Source : locales/locales.json  ("en" only until asked). ?lan=hi picks a
            language; missing keys fall back to English, then show the key.
   file:// cannot fetch JSON, so regenerate locales/locales.js after editing:
     node -e "const l=require('./locales/locales.json');require('fs').writeFileSync('locales/locales.js','window.LOCALES='+JSON.stringify(l)+';\n')"
*/
(function () {
  const SPEECH_LANG = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN', te: 'te-IN', gu: 'gu-IN', or: 'or-IN' };
  let table = { en: {} };
  let lang = 'en';
  /* false = no read-aloud at all (no clips, no browser speech). */
  const VOICE_ON = true;
  let voiceClips = {}; // clip id -> { text, dur, words: [[charOffset, startSec]] }
  const clipBlobs = {}; // clip id -> blob: URL (downloaded by the preloader)
  let currentClip = null;
  let duckSeq = 0; // the theme music stays ducked until the latest line ends
  let voiceReadyFn;
  const voiceReady = new Promise((res) => (voiceReadyFn = res));

  function cap(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  const I18n = {
    get lang() {
      return lang;
    },
    get langCode() {
      return SPEECH_LANG[lang] || lang;
    },
    /* Build a camelCase key from parts: key('piece', 'minor', 'sector') -> pieceMinorSector */
    key(...parts) {
      return parts
        .join('.')
        .split(/[.\-\s]+/)
        .filter(Boolean)
        .map((p, i) => (i ? cap(p) : p))
        .join('');
    },
    t(key, vars) {
      let s = table[lang] && table[lang][key];
      if (s == null) s = table.en[key];
      if (s == null) return key; // visible on purpose: fix the JSON
      if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
      return s;
    },
    has(key) {
      return (table[lang] && table[lang][key] != null) || table.en[key] != null;
    },
    applyStatic(root = document) {
      root.querySelectorAll('[data-i18n]').forEach((n) => {
        n.textContent = I18n.t(n.dataset.i18n);
      });
      document.documentElement.lang = lang;
    },
    /* File of a clip id (the preloaded copy when there is one). */
    voice(id) {
      return clipBlobs[id] || `assets/VO-${lang.toUpperCase()}/${id}.mp3`;
    },
    /* The clip id of a line: key + one tag per {var} in the English text. */
    clipId(key, vars) {
      const tpl = table.en[key] || '';
      const names = [...new Set((tpl.match(/\{\w+\}/g) || []).map((m) => m.slice(1, -1)))];
      if (!names.length) return key;
      return [key, ...names.map((n) => varTag(vars && vars[n]))].join('_');
    },
    /* Word start times for this line's clip: [[charOffset, seconds]] against
       T(key, vars) without its *marks* - or null (no clip, voice off, or the
       caption no longer matches the recording). */
    timing(key, vars) {
      const audio = window.ZD && ZD.audio;
      if (!VOICE_ON || (audio && audio.muted)) return null;
      const c = voiceClips[I18n.clipId(key, vars)];
      if (!c || c.text !== I18n.t(key, vars).replace(/\*/g, '')) return null;
      return c.words;
    },
    /* Plays the line; resolves when it has finished (or was cut off / could
       not play).  Never rejects.  onStart(true) fires when the clip starts
       to sound; onStart(false) when there is no clip to sync to. */
    say(key, vars, onStart) {
      const audio = window.ZD && ZD.audio;
      let started = false;
      const start = (synced) => {
        if (started) return;
        started = true;
        if (onStart) onStart(synced);
      };
      if (!VOICE_ON || (audio && audio.muted)) {
        start(false);
        return Promise.resolve();
      }
      I18n.stop();
      const line = sayLine(key, vars, start);
      // the theme music dips under the voice; an older line ending late
      // (its 'pause' fires after this one starts) does not bring it back up
      const seq = ++duckSeq;
      if (audio && audio.duck) audio.duck(true);
      return line.then(() => {
        if (seq === duckSeq && audio && audio.duck) audio.duck(false);
      });
    },
    /* Preloader hooks: resolves the clip files once the manifest is in. */
    voiceFiles() {
      return voiceReady.then(() => Object.keys(voiceClips).map((id) => ({ id, src: `assets/VO-${lang.toUpperCase()}/${id}.mp3` })));
    },
    useClipBlob(id, blob) {
      if (blob && !clipBlobs[id]) clipBlobs[id] = URL.createObjectURL(blob);
    },
    stop() {
      if (currentClip) {
        currentClip.pause();
        currentClip = null;
      }
      if (window.ZD && ZD.audio) ZD.audio.stopSpeech();
    },
    /* Load locales (+ the voice manifest), then call cb. */
    load(cb) {
      const q = new URLSearchParams(location.search).get('lan');
      if (q) lang = q.toLowerCase();
      const done = (data) => {
        table = data && data.en ? data : { en: {} };
        if (!table[lang]) lang = 'en';
        loadVoiceManifest().then(() => cb && cb());
      };
      const useScript = () => {
        if (window.LOCALES) return done(window.LOCALES);
        const s = document.createElement('script');
        s.src = 'locales/locales.js';
        s.onload = () => done(window.LOCALES);
        s.onerror = () => done(null);
        document.head.appendChild(s);
      };
      if (location.protocol === 'file:') return useScript(); // fetch is blocked on file://
      fetch('locales/locales.json')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(done)
        .catch(useScript); // offline / odd hosting: fall back to the generated locales.js
    },
  };

  /* The clip of the line (or browser speech when there is none). */
  function sayLine(key, vars, start) {
    const audio = window.ZD && ZD.audio;
    const id = I18n.clipId(key, vars);
    const speak = () => {
      start(false);
      return audio ? audio.say(I18n.t(key, vars)) : Promise.resolve();
    };
    // (a clip recorded for older wording is not played under the new caption)
    const c = voiceClips[id];
    if (!c || c.text !== I18n.t(key, vars).replace(/\*/g, '')) return speak();
    const a = new Audio(I18n.voice(id));
    currentClip = a;
    return new Promise((res) => {
      const end = () => {
        start(false); // (cut off before it sounded)
        res();
      };
      a.addEventListener('playing', () => start(true), { once: true });
      a.addEventListener('ended', end, { once: true });
      a.addEventListener('pause', end, { once: true });
      let failed = false; // (a bad file can both fire 'error' and reject play())
      const fail = () => {
        if (failed) return;
        failed = true;
        if (currentClip === a) speak().then(res);
        else end();
      };
      a.addEventListener('error', fail, { once: true });
      a.play().catch(fail);
    });
  }

  /* Number -> '3'; a piece name -> its id ('MINOR SECTOR' -> 'MinorSector'). */
  function varTag(v) {
    if (v == null) return '';
    const s = String(v);
    for (const t of [table[lang] || {}, table.en]) {
      const k = Object.keys(t).find((x) => x.startsWith('piece') && t[x] === s);
      if (k) return k.slice(5);
    }
    return s;
  }

  /* manifest.js (a script, so it also loads from file://); no clips -> speech. */
  function loadVoiceManifest() {
    voiceClips = {};
    const take = () => {
      const m = window.VO_MANIFEST && window.VO_MANIFEST[lang];
      if (m && m.clips && !Array.isArray(m.clips)) voiceClips = m.clips;
      voiceReadyFn();
    };
    if (!VOICE_ON) return Promise.resolve(take());
    return new Promise((res) => {
      const s = document.createElement('script');
      s.src = `assets/VO-${lang.toUpperCase()}/manifest.js`;
      s.onload = s.onerror = () => res(take());
      document.head.appendChild(s);
    });
  }

  window.I18n = I18n;
  window.T = I18n.t;
})();
