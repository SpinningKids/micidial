# MICIDIAL

**M**atrix-**I**nterleaved **C**hromatic **I**ndexing for **D**imensional
**I**somorphism & **A**lgebraic **L**atent-mapping.

MICIDIAL is a lossless compression engine that targets the HTML artifacts of
Dixan's ATBS demo system (the `bde-player.html` bundle). It rewrites a large,
already-minified single-file HTML page into a smaller single-file HTML page while
preserving **bit-for-bit fidelity** of behavior — representation changes,
functionality does not.

- **Version:** 1.0
- **Type:** Lossless (size/entropy) compression pipeline for web artifacts
- **Target input:** `bde-player.html` (~77 KB single-file HTML bundle)
- **Target output:** ≤ 64 KiB single-file HTML that renders identically

---

## Why it exists

The target page is a single HTML file with an already-minified inline script.
Plain whitespace/token minification cannot push it below the 64 KiB boundary,
which matters for certain embedding limits. MICIDIAL instead attacks **entropy**:
it packs all of the dynamic content (outer JS, embedded gzip blob, and both GLSL
shaders) into a single gzipped base64 payload that is inflated at runtime using
the standard browser `DecompressionStream('gzip')` API.

**Result:** ~77 KB → ~45 KB, lossless (verified).

---

## How it works

1. The input HTML is split into head / `<style>` / body / `<script>` / tail.
2. Three large string literals in the inline script are located by unique
   markers and each is replaced with a quoted **sentinel** token:
   - `H4sIAAAAAAAA…` — the embedded base64-gzip blob (`[engine.js, project]`)
   - first `"#version 300 es\n…"` — vertex shader source
   - second `"#version 300 es\n…"` — fragment shader source
3. The outer JS is minified with terser (`-c -m`, ASCII-only). Sentinels survive
   untouched as `\xNN` escape text.
4. The embedded blob is base64-decoded and gunzipped, the inner engine source is
   terser-minified, re-serialized compactly, and re-gzipped at level 9.
5. Shader literal **source** text (`\n` as two characters) is evaluated to
   runtime strings (real newlines) so the GLSL compiles at load time.
6. Everything — `{outerJs, vertexShader, fragmentShader, rebuiltBlob}` — is
   packed into one compact JSON object → gzip(-9) → base64 and embedded in a
   ~450-byte bootstrap script.
7. At runtime the bootstrap decodes the payload, splices the real values over the
   sentinels, and appends a `<script>` element (preserving the original
   global-scope execution semantics).

See `REBUILD.md` for the full procedure and the "gotchas learned the hard way"
that must not regress.

---

## Usage

```bash
# 1. Build from an original (output defaults to <input>.min.html)
python tools/minify.py bde-player.html

# 2. Verify — all four checks must PASS before deploying
node tools/diff_engine.js                                   # audio engine bit-exactness
node tools/verify_html.js bde-player.min.html               # payload round-trip + lossless parse
node tools/glsl_diff.js bde-player.html bde-player.min.html # GLSL byte-diff (headless)
node tools/browser_test.js bde-player.min.html              # console/DOM smoke test (headless)

# 3. Deploy only after all pass
mv bde-player.min.html bde-player.html
```

`tools/minify.py <input>` never overwrites its input; the output defaults to
`<input>.min.html`.

---

## Requirements

- **Python 3.10+** — build pipeline (`tools/minify.py`)
- **Node 18+** — verifiers; requires `DecompressionStream` (Chrome/Edge 80+,
  Firefox 113+, Safari 16.4+)
- **terser** — via `npx terser`

### Playwright (headless browser tests)

Not bundled (`node_modules` is excluded to keep the folder shareable). Install
before first use:

```bash
cd tools && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
# Chromium is cached in %LOCALAPPDATA%\ms-playwright; if absent:
npx playwright install chromium
```

---

## Repository layout

| Path | Purpose |
|---|---|
| `tools/minify.py` | full lossless build pipeline |
| `tools/eval_literals.js` | helper: raw literal text → runtime strings |
| `tools/diff_engine.js` | differential AudioWorklet test (bit-exact) |
| `tools/verify_html.js` | offline bootstrap round-trip + lossless checks |
| `tools/glsl_diff.js` | headless GLSL source diff vs original |
| `tools/browser_test.js` | headless smoke test (errors, DOM state) |
| `tools/build/` | build intermediates (regenerated each run; git-ignored) |
| `bde-player.html` | the target/deployed artifact |
| `bde-player.orig.html` | last known original, kept as reference |
| `MINIFY_PLAN.md` | original design plan for reaching < 64 KiB |
| `REBUILD.md` | instructions + gotchas for regenerating the artifact |

---

## Losslessness criteria

The rebuilt blob's bytes intentionally **differ** from the original (the engine
is re-minified and re-gzipped). A rebuild is considered lossless when:

- the decompressed project JSON is byte-identical, and
- the audio engine behaves identically (proven by `diff_engine.js`), and
- both GLSL shaders match the originals byte-for-byte.

Blob byte-equality is **not** a requirement.

---

## License

See `LICENSE`.
