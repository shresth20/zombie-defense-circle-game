#!/usr/bin/env python3
"""Cut a raw voice-over recording into the game's clips, with word timings.

LOCAL BUILD TOOL ONLY - nothing here uses the network (no ElevenLabs, no
downloads): Whisper runs on this machine from its cached model.  The output
(assets/VO-<LANG>/*.webm + *.mp3 + manifest.json/.js) is committed and loads
offline.

A recording is a list of sentences read once, in order, with a pause between
them - normally the whole script as `python3 tools/build-vo.py --list` prints
it.  Run with uv (cached packages, no network):

  HF_HUB_OFFLINE=1 uv run --offline --no-project --python 3.11 \\
      --with faster-whisper --with soundfile --with imageio-ffmpeg \\
      python tools/split-vo.py RAW.mp3

  --script S   what was read, if not today's script: a text file (one sentence
               per line) or git:<rev> (the script as of that commit)
  --add        keep the clips already there; only add/replace what this
               recording has (pick-ups for new or changed lines)
  --missing    no audio: print the lines that still have no clip (or a clip
               of older wording) - the list to record next
  --report     print every clip's words with their start times
  --out DIR    write elsewhere (default assets/VO-EN)

How it works:
  1. Whisper transcribes the recording; its words are matched to the script
     read (edit-distance alignment), which says roughly where each line is.
  2. Each line is cut in the pause between it and the next (audio level);
     the best in-order set of pauses wins.  Then Whisper hears all the cuts
     again in a row, well apart: each must hold its line and nothing else.
  3. Word timing: Whisper's word times from step 1 (with the lines around
     it as context it places words far better than on a short clip alone).
     Every stretch of speech between pauses then starts exactly where its
     sound does, and a word after a short silence (the stop before 'Tap')
     starts where the sound comes back.
  4. Each game line gets the recorded line with the same words (case and
     punctuation aside), or the part of one before/after a pause ('Time up!'
     from 'Time up. It was a minor arc.').  Clips: mono WebM/Opus 32 kbps
     (what the game plays) + mono MP3 (VBR ~80 kbps, the fallback where the
     browser has no Opus), 5 ms fades.  The manifest keeps each word's start as [charOffset, sec]
     against the caption text (no *marks*), as js/i18n.js and js/ui.js read.
"""
import argparse, glob, importlib.util, itertools, json, math, os, re, subprocess, tempfile

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HOP, WIN = 0.005, 0.02  # level meter: 5 ms steps, 20 ms window
SIL_DB = -50.0          # quieter = silence (speech sits around -30 dB)
LINE_GAP = 0.15         # a silence this long can separate two lines
PHRASE_GAP = 0.12       # a silence this long inside a line is a pause
SNAP_GAP = 0.03         # a shorter one (a stop consonant) can still pin a word...
SNAP_WIN = 0.10         # ...when Whisper starts that word this close to it
LEAD, TAIL = 0.05, 0.15 # audio kept before the first / after the last sound
FADE = 0.005
CHECK_GAP = 1.2         # silence between the cut lines when Whisper checks them
MIN_WORD = 0.06         # no two word starts closer than this
STOP = re.compile(r"^(?:t(?!h)|p(?!h)|k|b|d|g|q|c(?![eiy]))")  # opens with a stop consonant
MODEL = 'medium.en'
NUM = {'1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six',
       '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten'}


def build_vo():
    spec = importlib.util.spec_from_file_location('build_vo', os.path.join(ROOT, 'tools', 'build-vo.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def norm(w):
    w = re.sub(r"[^a-z0-9']", '', w.lower().replace('’', "'"))
    return NUM.get(w, w)


def said(text):
    """The spoken words of a line, normalised: ['oh', 'no', 'wrong', 'part']."""
    return [norm(t) for t in text.split() if norm(t)]


def align(a, b):
    """Edit-distance alignment of two token lists -> [(i, j)] matched or substituted."""
    n, m = len(a), len(b)
    D = np.zeros((n + 1, m + 1), dtype=np.int32)
    D[:, 0] = np.arange(n + 1)
    D[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            D[i, j] = min(D[i - 1, j - 1] + (a[i - 1] != b[j - 1]), D[i - 1, j] + 1, D[i, j - 1] + 1)
    i, j, out = n, m, []
    while i and j:
        if D[i, j] == D[i - 1, j - 1] + (a[i - 1] != b[j - 1]):
            out.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif D[i, j] == D[i - 1, j] + 1:
            i -= 1
        else:
            j -= 1
    return out[::-1]


def level(x, sr):
    """dB per HOP step; step k is centred on k*HOP seconds exactly (the step
    is not a whole number of samples at 44.1 kHz - rounding it once would
    drift ~0.4 s over a 3-minute recording)."""
    win = int(sr * WIN)
    pad = np.pad(x.astype(np.float64), (win // 2, win // 2))
    at = np.round(np.arange(int(len(x) / sr / HOP)) * HOP * sr).astype(np.int64)
    sq = np.concatenate([[0.0], np.cumsum(pad ** 2)])
    return 20 * np.log10(np.sqrt(np.maximum((sq[at + win] - sq[at]) / win, 0)) + 1e-9)


def runs(mask):
    """[start, end) index pairs of the True stretches of a bool array."""
    d = np.diff(np.r_[0, mask.astype(np.int8), 0])
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def read_script(spec, bvo):
    """The sentences of the recording, in the order they were read."""
    if spec and not spec.startswith('git:'):
        with open(spec, encoding='utf-8') as f:
            return [l.strip() for l in f if l.strip()]
    if not spec:
        return [bvo.spoken(t) for _, _, t in bvo.script(bvo.load_locale())]
    rev = spec[4:]
    show = lambda p: subprocess.run(['git', '-C', ROOT, 'show', f'{rev}:{p}'], capture_output=True,
                                    text=True, check=True).stdout
    loc = json.loads(show('locales/locales.json'))[bvo.LANG]
    block = show('js/config/missions.js').split('rounds: [', 1)[1].split(']', 1)[0]
    now = bvo.wall_count
    bvo.wall_count = lambda: len(re.findall(r'\{\s*tier', block))
    try:
        return [bvo.spoken(t) for _, _, t in bvo.script(loc)]
    finally:
        bvo.wall_count = now


def find_lines(model, raw, read, db):
    """Each sentence's speech [start, end) in seconds in the raw recording,
    and when Whisper hears each of its words: [[(start, end) or None]]."""
    segs, _ = model.transcribe(raw, language='en', word_timestamps=True, beam_size=5,
                               condition_on_previous_text=False, vad_filter=False)
    heard = [w for s in segs for w in s.words]
    exp = [(li, w) for li, text in enumerate(read) for w in said(text)]
    pairs = align([w for _, w in exp], [norm(w.word) for w in heard])
    span = {}
    for e, h in pairs:
        li = exp[e][0]
        s, t = span.get(li, (1e9, -1.0))
        span[li] = (min(s, heard[h].start), max(t, heard[h].end))
    times = [[None] * len(said(t)) for t in read]
    at = [(li, k) for li, text in enumerate(read) for k in range(len(said(text)))]
    for e, h in pairs:
        li, k = at[e]
        times[li][k] = (heard[h].start, heard[h].end)
    gone = [read[i] for i in range(len(read)) if i not in span]
    if gone:
        raise SystemExit(f'split-vo: no speech found for {gone} - is every line in the recording, in order?')
    subs = [(exp[e][1], heard[h].word.strip()) for e, h in pairs if exp[e][1] != norm(heard[h].word)]
    print(f'heard {len(heard)} words for {len(exp)} in the script; {len(subs)} heard differently: {subs}')

    # The cuts: one pause per line break, in order.  Whisper is loose about
    # pauses (a word after one often starts inside it), so every pause long
    # enough is a candidate and the best in-order set wins: near where Whisper
    # hears the break, and longer is likelier (a pause inside a line -
    # 'Correct. It is...' - is usually shorter).
    loud = np.where(db >= SIL_DB)[0]
    cand = [(a, b) for a, b in runs(db < SIL_DB) if (b - a) * HOP >= LINE_GAP and loud[0] < a and b <= loud[-1]]
    mid = np.array([(a + b) / 2 * HOP for a, b in cand])
    length = np.array([(b - a) * HOP for a, b in cand])
    nb, nc = len(read) - 1, len(cand)
    if nc < nb:
        raise SystemExit(f'split-vo: {nc} pauses for {nb} line breaks - re-record with a clear gap between lines')
    want = np.array([(span[i][1] + span[i + 1][0]) / 2 for i in range(nb)])
    cost = np.abs(mid[None, :] - want[:, None]) - 0.5 * length[None, :]
    best = np.full((nb, nc), np.inf)
    back = np.zeros((nb, nc), dtype=np.int32)
    best[0] = cost[0]
    for i in range(1, nb):
        run_arg = np.zeros(nc, dtype=np.int32)
        for j in range(1, nc):
            run_arg[j] = j if best[i - 1][j] < best[i - 1][run_arg[j - 1]] else run_arg[j - 1]
        best[i, 1:] = cost[i, 1:] + best[i - 1][run_arg[:-1]]
        back[i, 1:] = run_arg[:-1]
    pick = [int(np.argmin(best[-1]))]
    for i in range(nb - 1, 0, -1):
        pick.append(int(back[i, pick[-1]]))
    pick = pick[::-1]
    far = [(read[i], round(float(mid[j] - want[i]), 2)) for i, j in enumerate(pick) if abs(mid[j] - want[i]) > 0.8]
    if far:
        raise SystemExit(f'split-vo: line breaks far from where Whisper hears them {far} - check the recording')
    starts, ends = [loud[0] * HOP], []
    for j in pick:
        a, b = cand[j]
        ends.append(a * HOP)
        starts.append(b * HOP)
    ends.append((loud[-1] + 1) * HOP)
    return list(zip(starts, ends)), times


def sounds_like(text, heard):
    """The cut holds its line and nothing else: no word missing and none extra
    (one slip each way allowed in a line of more than three words).  A break
    put at a pause inside a line leaves one clip short and its neighbour long."""
    want = said(text)
    same = sum(want[i] == heard[j] for i, j in align(want, heard))
    slack = 1 if len(want) > 3 else 0
    return same >= len(want) - slack and len(heard) - same <= slack


def check_cuts(model, takes, sr, tmp):
    """Whisper hears all the cut lines again, in order, CHECK_GAP s of silence
    apart, and every word it hears goes to the clip it falls in; each clip
    must hold its own line.  (One clip alone is no test: Whisper turns a short
    one like 'minor arc' into 'Dear Ark', with the lines around it it hears
    them as it did in the recording.  The gap is wider than its time drift.)"""
    gap = np.zeros(int(sr * CHECK_GAP), dtype=np.float32)
    parts, where, t = [], [], CHECK_GAP
    for tk in takes:
        parts += [gap, tk['y']]
        where.append((t, t + len(tk['y']) / sr))
        t += len(tk['y']) / sr + CHECK_GAP
    path = os.path.join(tmp, 'all.wav')
    sf.write(path, np.concatenate(parts + [gap]), sr)
    segs, _ = model.transcribe(path, language='en', word_timestamps=True, beam_size=5,
                               condition_on_previous_text=False, vad_filter=False)
    heard = [[] for _ in takes]
    for s in segs:
        for w in s.words:
            m = (w.start + w.end) / 2
            k = int(np.argmin([0 if a <= m <= b else min(abs(m - a), abs(m - b)) for a, b in where]))
            heard[k].append(w.word)
    # (Whisper's pieces carry their own spaces: ' mix' + '-ups.' is one word)
    return [(tk['text'], ''.join(h).strip()) for tk, h in zip(takes, heard)
            if not sounds_like(tk['text'], said(''.join(h)))]


def syllables(w):
    """Rough syllable count of a word (vowel groups, a silent final 'e' off)."""
    g = re.findall(r'[aeiouy]+', w)
    return max(1, len(g) - (len(g) > 1 and w.endswith('e') and not w.endswith(('le', 'ee'))))


def breaks_after(text):
    """For each spoken word: does the text let the voice pause after it
    (',', '.', '!', '?', ':', ';', or a dash next)?"""
    out = []
    for t in text.split():
        if not norm(t):
            if out:
                out[-1] = True  # ('worry — let's')
            continue
        out.append(bool(re.search(r'[,.!?:;…]$', t)))
    return out


def stretches(ws, we, brk, ph):
    """Which sound stretch each word belongs to, in order.  Whisper often
    starts a word after a pause early, even in the stretch before, so the
    middle of a word alone is not enough: of all in-order ways, the one where
    words sit in their stretch and the stretches break where the text has a
    pause ('Correct! | It is...', not 'Correct! It | is...')."""
    mid = (ws + we) / 2
    off = np.array([[0 if a <= m <= b else min(abs(m - a), abs(m - b)) for a, b in ph] for m in mid])
    n, P = len(mid), len(ph)
    if math.comb(n + P - 1, n) > 20000:  # (never in practice) - the middle alone
        return np.maximum.accumulate(off.argmin(1))
    best, pick = None, None
    for who in itertools.combinations_with_replacement(range(P), n):
        cost = sum(off[j, p] for j, p in enumerate(who))
        cost += sum(0 if brk[j] else 0.5 for j in range(n - 1) if who[j] != who[j + 1])
        cost += 0.5 * (P - len(set(who)))  # a stretch with no word (a breath?)
        if best is None or cost < best:
            best, pick = cost, who
    return np.array(pick)


def timing(words, brk, ws, we, cdb):
    """Each word's start/end second in its clip, plus the sound stretch
    (between pauses) it belongs to: (start, end, who, ph).  The times are
    Whisper's in the whole recording, where it has the context to place words
    well (on a short clip alone it drags the first word out by ~0.4 s).  Then
    a stretch of speech starts exactly where its sound does (Whisper often
    starts that word inside the pause before), and a word that opens with a
    stop consonant ('Tap', 'gap') where its sound comes back after the
    closure - not one with a closure inside it ('ma-j-or')."""
    n = len(ws)
    idx = np.arange(n)
    ok = ~np.isnan(ws)
    ws, we = np.interp(idx, idx[ok], ws[ok]), np.interp(idx, idx[ok], we[ok])

    loud = np.where(cdb >= SIL_DB)[0]
    first, last = loud[0], loud[-1] + 1
    inner = [(first + a, first + b) for a, b in runs(cdb[first:last] < SIL_DB)]
    pauses = [(a, b) for a, b in inner if (b - a) * HOP >= PHRASE_GAP]
    stops = [(a, b) for a, b in inner if SNAP_GAP <= (b - a) * HOP < PHRASE_GAP]
    ph = [(a * HOP, b * HOP) for a, b in zip([first] + [b for _, b in pauses], [a for a, _ in pauses] + [last])]

    who = stretches(ws, we, brk, ph)

    start, end = ws.copy(), we.copy()
    for p, (a, b) in enumerate(ph):
        k = np.where(who == p)[0]
        if not len(k):
            continue
        start[k] = np.clip(start[k], a, b - MIN_WORD)
        end[k] = np.clip(end[k], a, b)
        start[k[0]], end[k[-1]] = a, b
        # now and then Whisper hands one word its neighbour's time ('a' 0.39 s,
        # 'major' 0.07 s): such a pair shares its time out by syllables
        for j in k[:-1]:
            stop = start[j + 2] if j + 2 <= k[-1] else b
            s1, s2 = syllables(words[j]), syllables(words[j + 1])
            r1, r2 = (start[j + 1] - start[j]) / s1, (stop - start[j + 1]) / s2
            if min(r1, r2) < 0.07 and max(r1, r2) > 3 * max(min(r1, r2), 1e-3):
                start[j + 1] = start[j] + (stop - start[j]) * s1 / (s1 + s2)
        used = set()
        for j in k[1:]:
            if not STOP.match(words[j]):
                continue
            near = [(abs(sb * HOP - start[j]), sb) for _, sb in stops
                    if a < sb * HOP < b and sb not in used and abs(sb * HOP - start[j]) <= SNAP_WIN]
            if near:
                sb = min(near)[1]
                used.add(sb)
                start[j] = sb * HOP
    for j in range(1, n):
        start[j] = max(start[j], start[j - 1] + MIN_WORD)
    return start, end, who, ph


def source_for(words, takes):
    """Which recorded take (and which of its words) gives this line's audio:
    the whole take, or its part before / after a pause.  None = not recorded."""
    n = len(words)
    for t in takes:
        if t['words'] == words:
            return t, 0, n
    for t in takes:
        w, who = t['words'], t['who']
        if len(w) > n and w[:n] == words and who[n] != who[n - 1]:
            return t, 0, n
        if len(w) > n and w[-n:] == words and who[-n] != who[-n - 1]:
            return t, len(w) - n, len(w)
    return None


def cut(t, i, j, sr):
    """Audio + word times of words i..j-1 of take t (the take cut at its pauses)."""
    y, ph, who = t['y'], t['ph'], t['who']
    lo, hi = 0.0, len(y) / sr
    if i > 0:
        a, prev = ph[who[i]][0], ph[who[i] - 1][1]
        lo = max(a - LEAD, (prev + a) / 2)
    if j < len(t['words']):
        b, nxt = ph[who[j - 1]][1], ph[who[j - 1] + 1][0]
        hi = min(b + TAIL, (b + nxt) / 2)
    seg = fades(y[int(lo * sr):int(hi * sr)], sr)
    return seg, t['start'][i:j] - lo, np.minimum(t['end'][i:j], hi) - lo


def fades(y, sr):
    k = int(sr * FADE)
    r = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, k))
    y = y.copy()
    y[:k] *= r
    y[-k:] *= r[::-1]
    return y


def voice_name(raw):
    """'ElevenLabs_<date>_Josh - Warm, Smooth and Steady_pvc_...mp3' -> 'ElevenLabs: Josh - Warm, ...'."""
    m = re.match(r'ElevenLabs_\d{4}-\d\d-\d\dT\d\d_\d\d_\d\d_([^_]+)_', os.path.basename(raw))
    return ('ElevenLabs: ' + m.group(1)) if m else os.path.splitext(os.path.basename(raw))[0]


def write_manifest(out, man, bvo):
    """manifest.json (one clip per row) and manifest.js (what the game loads)."""
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        f.write('{\n')
        for k, v in man.items():
            if k != 'clips':
                f.write(f' {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n')
        f.write(' "clips": {\n')
        rows = [f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(",", ":"))}'
                for k, v in man['clips'].items()]
        f.write(',\n'.join(rows) + '\n }\n}\n')
    # the same data as a script, for file:// (where fetch is blocked)
    lang = bvo.LANG
    with open(os.path.join(out, 'manifest.js'), 'w', encoding='utf-8') as f:
        f.write('/* generated by tools/split-vo.py from manifest.json - do not edit */\n')
        f.write('window.VO_MANIFEST = window.VO_MANIFEST || {};\n')
        f.write(f'window.VO_MANIFEST[{json.dumps(lang)}] = {json.dumps(man, ensure_ascii=False, separators=(",", ":"))};\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('raw', nargs='?')
    ap.add_argument('--script', default=None)
    ap.add_argument('--add', action='store_true')
    ap.add_argument('--missing', action='store_true')
    ap.add_argument('--out', default=None)
    ap.add_argument('--model', default=MODEL)
    ap.add_argument('--voice', default=None, help='voice name for the manifest (default: from the file name)')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    bvo = build_vo()
    lines = bvo.script(bvo.load_locale())  # what the game says today
    out = a.out or os.path.join(ROOT, 'assets', 'VO-' + bvo.LANG.upper())
    man_path = os.path.join(out, 'manifest.json')
    old = json.load(open(man_path, encoding='utf-8')) if os.path.exists(man_path) else {}
    have = old.get('clips', {}) if isinstance(old.get('clips'), dict) else {}

    def unvoiced():
        return [(cid, text) for cid, _, text in lines
                if have.get(cid, {}).get('text') != text.replace('*', '')]
    if a.missing:
        for _, text in unvoiced():
            print(bvo.spoken(text))
        return
    if not a.raw:
        ap.error('the raw recording is needed (or --missing)')

    bvo.ffmpeg_exe()  # (the .webm clips need it: fail now, not after Whisper)
    from faster_whisper import WhisperModel

    read = read_script(a.script, bvo)
    x, sr = sf.read(a.raw, dtype='float32', always_2d=True)
    x = x.mean(1)
    db = level(x, sr)
    print(f'{os.path.basename(a.raw)}: {len(x) / sr:.1f}s, {len(read)} lines read; Whisper {a.model} (local)')
    model = WhisperModel(a.model, device='cpu', compute_type='int8')
    spans, times = find_lines(model, a.raw, read, db)

    takes = []
    with tempfile.TemporaryDirectory() as tmp:
        for i, (text, (s, e)) in enumerate(zip(read, spans)):
            lo = s - LEAD if i == 0 else max(s - LEAD, (spans[i - 1][1] + s) / 2)
            hi = e + TAIL if i == len(read) - 1 else min(e + TAIL, (e + spans[i + 1][0]) / 2)
            lo, hi = max(0.0, lo), min(len(x) / sr, hi)
            y = x[int(lo * sr):int(hi * sr)]
            ws = np.array([t[0] - lo if t else np.nan for t in times[i]])
            we = np.array([t[1] - lo if t else np.nan for t in times[i]])
            words = said(text)
            start, end, who, ph = timing(words, breaks_after(text), ws, we, level(y, sr))
            takes.append({'text': text, 'words': words, 'y': y, 'start': start, 'end': end, 'who': who, 'ph': ph})
            print(f'  cut {i + 1}/{len(read)}: {text}', flush=True)
        print('checking the cuts...', flush=True)
        bad = check_cuts(model, takes, sr, tmp)
    if bad:
        raise SystemExit(f'split-vo: these cuts do not sound like their line (nothing written): {bad}')

    os.makedirs(out, exist_ok=True)
    if not a.add:
        have = {}
        for f in glob.glob(os.path.join(out, '*.mp3')) + glob.glob(os.path.join(out, '*.webm')):
            os.remove(f)
    used, made = set(), []
    for cid, _, text in lines:
        toks = [(m.start(), norm(m.group(0))) for m in re.finditer(r'\S+', text.replace('*', ''))]
        src = source_for([sp for _, sp in toks if sp], takes)
        if not src:
            continue
        t, i, j = src
        used.add(t['text'])
        y, st, en = cut(t, i, j, sr)
        sf.write(os.path.join(out, cid + '.mp3'), y, sr, format='MP3', subtype='MPEG_LAYER_III',
                 compression_level=0.5, bitrate_mode='VARIABLE')
        bvo.write_webm(os.path.join(out, cid + '.webm'), pcm=y, sr=sr)
        words, k = [], 0
        for off, sp in toks:
            if sp:
                words.append([off, round(float(st[k]), 3)])
                k += 1
            else:  # a mark like '—' shows as the word before it ends
                prev = float(en[k - 1]) if k else 0.0
                words.append([off, round(min(prev, float(st[k])) if k < len(st) else prev, 3)])
        plain = text.replace('*', '')
        have[cid] = {'text': plain, 'dur': round(len(y) / sr, 3), 'words': words}
        made.append(cid)
        if a.report:
            shown = '  '.join(f'{plain[o:].split()[0]}@{s:.2f}' for o, s in words)
            print(f'{cid:30} {len(y) / sr:5.2f}s  {shown}')

    ids = {cid for cid, _, _ in lines}
    for cid in [c for c in have if c not in ids]:  # lines the game no longer has
        del have[cid]
        for ext in ('.mp3', '.webm'):
            if os.path.exists(os.path.join(out, cid + ext)):
                os.remove(os.path.join(out, cid + ext))
    man = {
        '_comment': 'Built by tools/split-vo.py from raw recordings. clips: id -> {text, dur, '
                    'words:[[charOffset, startSec]]}. Ids not listed fall back to browser speech.',
        'voice': (a.voice or old.get('voice')) if a.add else (a.voice or voice_name(a.raw)),
        'sources': (old.get('sources', []) if a.add else []) + [
            {'file': os.path.basename(a.raw), 'script': a.script or 'current'}],
        'format': f'webm opus mono {bvo.VO_OPUS} (+ mp3 mono {sr} Hz VBR fallback)',
        'clips': dict(sorted(have.items())),
    }
    write_manifest(out, man, bvo)
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(out, '*.webm')))
    print(f'\n{len(made)} clips cut, {len(have)} in the manifest, {size / 1e6:.2f} MB -> {os.path.relpath(out, ROOT)}')
    spare = [t['text'] for t in takes if t['text'] not in used]
    if spare:
        print(f'recorded but not in the game now ({len(spare)}):\n  ' + '\n  '.join(spare))
    left = unvoiced()
    if left:
        print(f'still to record ({len(left)}) - browser speech until then:\n  '
              + '\n  '.join(bvo.spoken(t) for _, t in left))


if __name__ == '__main__':
    main()
