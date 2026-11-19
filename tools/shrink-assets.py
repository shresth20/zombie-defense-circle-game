#!/usr/bin/env python3
"""
Shrink the shipped WebP art in assets/build/ so the whole game stays under ~8 MB.

Run AFTER tools/build-assets.py (which writes the full-size WebP files):

    python3 tools/shrink-assets.py            (needs Pillow)

What it does
  * sprite sheets (hero/, zombie/, zombie2/) are re-sampled to SPRITE_SCALE
  * backdrop layers (bg/) are re-sampled to BG_SCALE
  * ui/, props/ and wall/ keep their pixel size: the banner is drawn with
    border-image slices in image pixels, so it must not be resized
  * everything is re-encoded as lossy WebP at QUALITY / ALPHA_QUALITY and a
    file is only replaced when the new one is smaller

The manifest is NOT changed.  The runtime draws every sheet and layer with an
explicit CSS size taken from the manifest (background-size: fw*cols x fh*rows,
100% 100%, or a fixed tile size), so a smaller file draws at the same place
and size; only its pixel density drops.

Re-running is safe: tools/shrink-stamp.json records the size of every file
this tool wrote, and a file whose size still matches is skipped (re-encoding
an already shrunk file again would only add loss).  A file rewritten by
build-assets.py has a new size and is shrunk again.
"""
import io
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "assets" / "build"
STAMP = Path(__file__).resolve().parent / "shrink-stamp.json"

QUALITY = 72        # colour quality (build-assets.py writes 80-90)
ALPHA_QUALITY = 70  # lossy alpha; edges checked on the sprites at game scale
SPRITE_SCALE = 0.80
BG_SCALE = 0.85
SCALE_BY_DIR = {"hero": SPRITE_SCALE, "zombie": SPRITE_SCALE, "zombie2": SPRITE_SCALE, "bg": BG_SCALE}


def touches_cell_edge(im, rel):
    """True if a sprite sheet has art on a cell border.  Re-sampled, a cell
    edge lands between pixels, so the frame next to it would bleed 1px in."""
    sheets = json.loads((BUILD / "manifest.json").read_text())["sprites"].values()
    s = next((s for s in sheets if s["src"] == rel), None)
    if s is None or im.mode != "RGBA":
        return False
    alpha = im.getchannel("A")
    W, H = im.size
    edges = [(c * s["fw"] - 2, 0, c * s["fw"] + 2, H) for c in range(1, s["cols"])]
    edges += [(0, r * s["fh"] - 2, W, r * s["fh"] + 2) for r in range(1, s["rows"])]
    return any(alpha.crop(box).getextrema()[1] > 8 for box in edges)


def shrink(rel):
    path = BUILD / rel
    before = path.stat().st_size
    im = Image.open(path)
    im.load()
    k = SCALE_BY_DIR.get(Path(rel).parts[0], 1.0)
    if k < 1 and touches_cell_edge(im, rel):
        k = 1.0  # keep full size, re-encode only
    if k < 1:
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    buf = io.BytesIO()
    opts = {"quality": QUALITY, "method": 6}
    if im.mode == "RGBA":
        opts["alpha_quality"] = ALPHA_QUALITY
    im.save(buf, "WEBP", **opts)
    # a resized file must always be written (it is the point); an unresized
    # one only when the re-encode actually saves bytes
    if k < 1 or buf.tell() < before:
        path.write_bytes(buf.getvalue())
    return rel, before, path.stat().st_size


def main():
    stamp = json.loads(STAMP.read_text()) if STAMP.exists() else {}
    todo = []
    for path in sorted(BUILD.rglob("*.webp")):
        rel = path.relative_to(BUILD).as_posix()
        if stamp.get(rel) == path.stat().st_size:
            continue  # already shrunk by this tool
        todo.append(rel)
    if not todo:
        print("nothing to do - every file is already shrunk")
        return
    total_before = total_after = 0
    with ProcessPoolExecutor() as ex:
        for rel, before, after in ex.map(shrink, todo):
            stamp[rel] = after
            total_before += before
            total_after += after
            print(f"{rel:40s} {before / 1024:7.0f} KB -> {after / 1024:6.0f} KB")
    STAMP.write_text(json.dumps(dict(sorted(stamp.items())), indent=1) + "\n")
    print(f"\n{len(todo)} files: {total_before / 1048576:.2f} MB -> {total_after / 1048576:.2f} MB")


if __name__ == "__main__":
    main()
