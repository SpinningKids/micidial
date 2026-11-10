# REBUILD.md — Re-minifying `bde-player.html` below 64 KiB

Instructions for an AI agentic coder to regenerate the minimized
`bde-player.html` from any future iteration of the original file.

## Background

The page is a single-line HTML with an already-minified inline script. Plain
minification cannot reach 64 KiB. The pipeline instead exploits **entropy**:

1. The script embeds a base64 **gzip blob** containing `[engine.js, project JSON]`.
2. Everything dynamic (outer JS + both GLSL shaders + rebuilt blob) is packed
   into **one gzipped base64 payload** that a ~450-byte bootstrap inflates at
   runtime with the standard `DecompressionStream('gzip')` API and executes as
   a dynamically injected `<script>` element.

Result: ~77 KB -> ~45.5 KB, lossless (verified bit-for-bit, see Verification).

## Requirements

- Python 3.10+
- Node 18+ (DecompressionStream needed by verifiers) and `npx terser`
- Playwright for the browser verifiers. Not bundled (`node_modules` is
  excluded to keep the folder shareable); install before first use:
  `cd tools && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`
  (Chromium itself is cached in `%LOCALAPPDATA%\ms-playwright`; if absent run
  `npx playwright install chromium`).

## Standard rebuild procedure

```bash
# from the project root

# 1. Keep a backup of the current original and run the pipeline on it
cp bde-player.html bde-player.orig.html          # skip if .orig.html already exists
python tools/minify.py bde-player.orig.html      # writes bde-player.orig.min.html

# 2. Verify — all four must PASS before deploying
node tools/diff_engine.js                                   # audio engine bit-equivalence
node tools/verify_html.js bde-player.orig.min.html          # payload round-trip + parse
node tools/glsl_diff.js bde-player.orig.html bde-player.orig.min.html   # GLSL byte-diff (headless)
node tools/browser_test.js bde-player.orig.min.html         # console/DOM smoke test (headless)

# 3. Deploy only after all pass
mv bde-player.orig.min.html bde-player.html
```

`tools/minify.py bde-player.html` also works directly; it never overwrites its
input (output defaults to `<input>.min.html`).

## How the pipeline works (`tools/minify.py`)

1. Splits input into head / `<style>` / body / `<script>` / tail.
2. Locates three big string literals in the JS by unique markers and swaps each
   for a quoted sentinel token (`\x01B\x01`, `\x01V\x01`, `\x01F\x01`):
   - `H4sIAAAAAAAA...` — the embedded base64-gzip blob (may be nested inside a
     JSON structure within another expression)
   - first `"#version 300 es\n..."` literal — vertex shader
   - second one — fragment shader
   Escaped quotes (`\"`) inside literals are handled during end-scan.
3. Terser-minifies outer JS (`-c -m --format ascii_only=true`). Sentinels
   survive as `\xNN` escape text.
4. Base64-decodes + gunzips the blob, tersers the inner engine source,
   re-serializes compactly, re-gzips at level 9.
5. Converts shader literal *source text* to *runtime strings* via
   `tools/eval_literals.js` (Node eval) — critical, see Gotcha #2.
6. Packs `{j: outerJs, v: vsh, f: fsh, b: newBlobBase64}` as compact JSON ->
   gzip -9 -> base64 into the bootstrap.
7. Bootstrap: `atob` -> `Uint8Array` -> `DecompressionStream('gzip')` -> parse ->
   splice quoted values over quoted sentinels (`split(...).join(...)` to avoid
   `$`-pattern hazards in `String.replace`) -> append `<script>` element.

Intermediates land in `tools/build/` (meta.json, engine.js, payloads...) and
are consumed by the verifiers.

## Gotchas learned the hard way — do not regress these

1. **Sentinels must not contain their own search marker** (the shader search
   string is reused twice), must be unique after minification, and must be
   replaced **including their surrounding double quotes**, otherwise you get
   `""H4sIA..."` double-quoting and a syntax error.
2. **Shader literals must be evaluated to runtime values** before packing.
   The raw source contains `\n` as two characters; the runtime string contains
   real newlines. Packing raw text yields GLSL like `#version 300 es\n...`
   literally and every shader fails to compile.
3. **Use `split/join`, not `replace`** when substituting values into the code:
   replacement strings containing `$&`/`$'` would corrupt output.
4. **Blob comparison**: the rebuilt blob's bytes differ from the original
   (engine re-minified, re-gzipped). Losslessness criterion is: decompressed
   project JSON byte-identical + engine behaviorally identical (proven by
   diff_engine), NOT blob byte-equality.
5. Verify the bootstrap actually captured the script element in tests; a
   no-op substitution or regex without a capture group can silently "pass".

## If a future iteration breaks the assumptions

- **Markers changed**: update `'H4sIAAAAAAAA'` / `'#version 300 es'` in
  `tools/minify.py` (`strip_literal` calls). Find new markers with:
  `grep -o 'H4sIAAAAAAAA' ...` / inspect big string literals.
- **More/fewer embedded literals**: add/remove sentinel+marker pairs following
  the same pattern (token, strip_literal call, meta.json entry, payload key,
  bootstrap split/join line).
- **Layout changed** (multiple scripts/styles): adjust the extraction indices
  in step 1 of `main()`.
- **New large assets**: consider adding them to the gzip payload rather than
  leaving them as plain literals.

## File map

| File | Purpose |
|---|---|
| `tools/minify.py` | full build pipeline |
| `tools/eval_literals.js` | helper: raw literal text -> runtime strings |
| `tools/diff_engine.js` | differential AudioWorklet test (bit-exact) |
| `tools/verify_html.js` | offline bootstrap round-trip + lossless checks |
| `tools/glsl_diff.js` | headless GLSL source diff vs original |
| `tools/browser_test.js` | headless smoke test (errors, DOM state) |
| `tools/build/` | intermediates (safe to delete; regenerated each run) |
| `bde-player.orig.html` | last known original, kept as reference |
