---
name: compression
description: Shrink an HTML/JS game without changing behaviour, deleting every converted original. Run only when asked.
---

# Compression

1. Baseline: play every scene headless; log errors, 404s, screenshots. Temp files go in the scratchpad.
2. Convert: images → WebP, audio/video → WebM, icons → SVG, animations → animated WebP, fonts → WOFF2 (used faces only).
3. Delete unreferenced files and dead code (scope-aware parser, not grep).
4. Point everything at the new files only: paths, fallback branches (`canPlayType ? 'webm' : 'mp3'` → `'webm'`), `tools/` scripts that write old formats, and docs mentioning them.
5. Re-run the baseline: no new errors or 404s, screenshots match.
6. Delete every original, duplicate and backup. Don't ask: git is the backup. Ask only about untracked files with no other copy.
7. Prove it. This must print nothing; otherwise go back to step 4:

   ```sh
   git ls-files -co --exclude-standard | grep -iE '\.(png|jpe?g|gif|bmp|tiff?|mp3|wav|ogg|m4a|aac|flac|mp4|mov|avi|ttf|otf|woff|bak|orig)$'
   ```

8. Report sizes before/after, files deleted, and the empty check.

## Never

- Keep an original because the code still falls back to it.
- Leave tools or docs that recreate or require originals.
- Put off deleting as a "next step".
