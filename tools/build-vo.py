#!/usr/bin/env python3
"""Build the voice-over clips from locales/locales.json with ElevenLabs.

LOCAL BUILD TOOL ONLY - the game never calls ElevenLabs. Its output
(assets/VO-<LANG>/*.mp3 + manifest.json) is committed and loads offline.
Project rule: only run this after the user has given the exact ElevenLabs
confirmation for that request.

  ELEVENLABS_API_KEY=... python3 tools/build-vo.py              # every clip
  ELEVENLABS_API_KEY=... python3 tools/build-vo.py --only storyAttack guideCorrect_MinorSector
  ELEVENLABS_API_KEY=... python3 tools/build-vo.py --voice <id> --out /tmp/x --only ...
  python3 tools/build-vo.py --list                               # script + counts, no API

One clip per spoken line.  A line with {vars} gets one clip per value it can
take; the clip id is  key_<tag>[_<tag>]  in the order the vars appear in the
text (numbers as-is, a piece name as its id, e.g. guideCorrect_MinorSector,
guideWall_3_6).  js/i18n.js builds the same id at runtime.

Word sync: the clip is made with ElevenLabs character timestamps; the start
time of every word is stored in the manifest as [charOffset, seconds] against
the line's plain text (the locale text without *...* marks), so the caption
bar can reveal each word as it is spoken.
"""
import argparse, base64, json, os, re, sys, time, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANG = 'en'
VOICE = 'siw1N9V8LmYeEWKyWBxv'  # Ruhaan - Clear, Loud and Cheerful (Indian English, male)
MODEL = 'eleven_multilingual_v2'
# calm and even: high stability keeps the pitch and tone the same clip to
# clip, style 0 adds no drama, one seed for every clip (one "take"); speed a
# little slow for grade 6-7
SETTINGS = {'stability': 0.85, 'similarity_boost': 0.8, 'style': 0.0, 'use_speaker_boost': True, 'speed': 0.86}
SEED = 4242
FORMAT = 'mp3_44100_64'

PIECES = ['MinorArc', 'MajorArc', 'MinorSector', 'MajorSector', 'MinorSegment', 'MajorSegment']
# spoken outside the caption bar (screens, review card)
EXTRA = ['mission1', 'endTitle', 'endSub', 'endNoMixups', 'goTitle', 'goSub']


def load_locale():
    with open(os.path.join(ROOT, 'locales', 'locales.json'), encoding='utf-8') as f:
        return json.load(f)[LANG]


def wall_count():
    src = open(os.path.join(ROOT, 'js', 'config', 'missions.js'), encoding='utf-8').read()
    block = src.split('rounds: [', 1)[1].split(']', 1)[0]
    return len(re.findall(r'\{\s*tier', block))


def var_values(var, n_walls, key=''):
    if var == 'name':
        return [(p, 'piece' + p) for p in PIECES]  # (tag, locale key of the value)
    if var == 'n' and key.startswith('story'):
        return [(str(n_walls), None)]  # the intro always counts every wall
    if var == 'n':
        return [(str(i), None) for i in range(1, n_walls + 1)]
    if var == 'total':
        return [(str(n_walls), None)]
    raise SystemExit(f'build-vo: no values known for {{{var}}} - add them to var_values()')


def script(loc):
    """[(clip id, locale key, caption text with *marks*)]"""
    n_walls = wall_count()
    keys = [k for k in loc if k.startswith(('story', 'guide', 'hint'))]
    keys += ['piece' + p for p in PIECES] + ['rule' + p for p in PIECES] + EXTRA
    out = []
    for key in keys:
        tpl = loc[key]
        names = list(dict.fromkeys(re.findall(r'\{(\w+)\}', tpl)))
        combos = [([], tpl)]
        for var in names:
            nxt = []
            for tags, text in combos:
                for tag, vkey in var_values(var, n_walls, key):
                    if var == 'n' and 'total' in names and int(tag) >= n_walls:
                        continue  # the last wall says guideWallLast instead
                    val = loc[vkey] if vkey else tag
                    nxt.append((tags + [tag], text.replace('{%s}' % var, val)))
            combos = nxt
        for tags, text in combos:
            out.append(('_'.join([key] + tags), key, text))
    return out


def spoken(text):
    """What the voice reads: no *marks*, names in CAPS read as words, and
    '!' read as '.', so no line is shouted (the caption keeps its '!').
    Same length as the caption text, so the word offsets still match it."""
    plain = text.replace('*', '')
    plain = re.sub(r'\b[A-Z]{2,}(?:\s+[A-Z]{2,})*\b', lambda m: m.group(0).lower(), plain)
    return plain.replace('!', '.').replace('↻', '').strip()


def word_starts(plain, alignment):
    chars = alignment['characters']
    starts = alignment['character_start_times_seconds']
    said = ''.join(chars)
    if said != plain:
        raise RuntimeError(f'alignment text differs: {said!r} vs {plain!r}')
    out = []
    for m in re.finditer(r'\S+', plain):
        out.append([m.start(), round(starts[m.start()], 3)])
    return out


def tts(key, voice, text):
    url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps?output_format={FORMAT}'
    body = json.dumps({'text': text, 'model_id': MODEL, 'voice_settings': SETTINGS, 'seed': SEED}).encode()
    req = urllib.request.Request(url, body, {'xi-api-key': key, 'Content-Type': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f'HTTP {e.code}: {msg[:300]}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--voice', default=VOICE)
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'VO-' + LANG.upper()))
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()

    loc = load_locale()
    lines = script(loc)
    if a.only:
        lines = [l for l in lines if l[0] in a.only]
        missing = set(a.only) - {l[0] for l in lines}
        if missing:
            raise SystemExit(f'unknown clip ids: {sorted(missing)}')
    if a.list:
        for cid, _, text in lines:
            print(f'{cid:34} {spoken(text)}')
        w = sum(len(spoken(t).split()) for *_, t in lines)
        c = sum(len(spoken(t)) for *_, t in lines)
        print(f'\n{len(lines)} clips, {w} words, {c} characters')
        return

    key = os.environ.get('ELEVENLABS_API_KEY')
    if not key:
        raise SystemExit('set ELEVENLABS_API_KEY')
    os.makedirs(a.out, exist_ok=True)
    man_path = os.path.join(a.out, 'manifest.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else {}
    clips = man.get('clips', {}) if isinstance(man.get('clips'), dict) else {}

    for i, (cid, lkey, text) in enumerate(lines, 1):
        plain = spoken(text)
        res = tts(key, a.voice, plain)
        with open(os.path.join(a.out, cid + '.mp3'), 'wb') as f:
            f.write(base64.b64decode(res['audio_base64']))
        al = res['alignment']
        clips[cid] = {
            'text': text.replace('*', ''),
            'dur': round(al['character_end_times_seconds'][-1], 3),
            'words': word_starts(plain, al),
        }
        print(f'[{i}/{len(lines)}] {cid}: {clips[cid]["dur"]}s  {plain}', flush=True)

    man = {
        '_comment': 'Built by tools/build-vo.py. clips: id -> {text, dur, words:[[charOffset, startSec]]}. '
                    'Ids not listed fall back to browser speech.',
        'voice': a.voice, 'model': MODEL, 'format': FORMAT,
        'clips': dict(sorted(clips.items())),
    }
    with open(man_path, 'w', encoding='utf-8') as f:
        f.write('{\n')
        head = {k: v for k, v in man.items() if k != 'clips'}
        for k, v in head.items():
            f.write(f' {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},\n')
        f.write(' "clips": {\n')
        rows = [f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(",", ":"))}' for k, v in man['clips'].items()]
        f.write(',\n'.join(rows) + '\n }\n}\n')
    write_js(a.out)


def write_js(out):
    """manifest.js: the same data for file:// (where fetch is blocked)."""
    with open(os.path.join(out, 'manifest.json'), encoding='utf-8') as f:
        man = json.load(f)
    lang = os.path.basename(out.rstrip('/')).split('-')[-1].lower()
    with open(os.path.join(out, 'manifest.js'), 'w', encoding='utf-8') as f:
        f.write('/* generated by tools/build-vo.py from manifest.json - do not edit */\n')
        f.write('window.VO_MANIFEST = window.VO_MANIFEST || {};\n')
        f.write(f'window.VO_MANIFEST[{json.dumps(lang)}] = {json.dumps(man, ensure_ascii=False, separators=(",", ":"))};\n')


if __name__ == '__main__':
    main()
