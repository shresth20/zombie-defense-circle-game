---
name: folder-structure
description: Required folder layout for every game (HTML/CSS/JS). Apply from the first file created.
---

# Folder structure

```text
index.html      entry point, root only
assets/         all media, by type: fonts/, VO/, images/, videos/, audio/, …
css/            all stylesheets
js/             all scripts (incl. vendored libs, e.g. gsap)
locales/        locales.json (+ locales.js)
tools/          build/dev scripts only, if needed
```

- No loose files at root besides `index.html` and config.
- No inline `<style>`/`<script>` blocks; link files from `css/` and `js/`.
- Relative paths only.
