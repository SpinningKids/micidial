# Plan: Reduce `bde-player.html` below 64 KB (lossless)

## Goal

Shrink `bde-player.html` (currently **77,152 bytes**) to below **65,536 bytes**
(64 KiB), keeping it a single valid HTML file that renders identically in a
standard web browser. All transformations must be **lossless to content/behavior**:
representation may change, functionality may not.

## Measured facts

| Component | Current bytes | After transform | Method |
|---|---|---|---|
| HTML shell + CSS | ~2,318 | ~2,200 | minify CSS |
| Outer JS (plain) | ~31,700 | ~31,000 | terser `-c -m` (already near-minimal) |
| Embedded base64 blob | 26,934 | 24,624 | gunzip -> JSON `[engine.js, project]` -> terser engine.js -> compact re-serialize -> `gzip -9` -> base64 |
| Fragment shader string | 15,159 | (inside payload) | moved into compressed payload |
| Vertex shader string | 82 | (inside payload) | moved into compressed payload |

**Key insight:** the page is already minified; the remaining win is *entropy*.
46.9 KB of plain JS + GLSL compresses to ~16.7 KB when gzipped as one payload
and decoded at runtime with the standard `DecompressionStream('gzip')` API.

**Projected result: ~44,000 bytes.**

## Execution steps

1. **Workspace**: work in a scratch dir; never overwrite the original until the
   result is verified. Keep `bde-player.html` untouched until sign-off
   (write output to `bde-player.min.html`, then replace only after verification).
2. **Extract** `<style>` body (minify it) and `<script>` body into files.
3. **Locate the three big string literals** inside the script by marker:
   - blob literal: starts `H4sIAAAAAAAA` (base64 of gzip)
   - vertex shader: first `"#version 300 es\n..."` literal
   - fragment shader: second `"#version 300 es\n..."` literal
   Handle escaped quotes (`\"`) when scanning literal ends.
4. **Replace each literal with a unique ASCII sentinel** string in the source,
   e.g. `"\x01BLOB\x01"` -> actually use printable unique tokens
   `@@BLOB@@`, `@@VSH@@`, `@@FSH@@` wrapped as string literals, so they survive
   terser untouched.
5. **Minify outer JS**: `npx terser outer.js -c -m --format ascii_only=true`.
   Sentinels remain intact.
6. **Rebuild the embedded blob**: base64-decode, gunzip, `JSON.parse` ->
   `[engineSrc, project]`; run terser on `engineSrc`; re-serialize with
   `JSON.dumps(..., separators=(',',':'))`; `gzip.compress(level=9)`; base64.
7. **Build runtime payload**: JSON object `{j: minifiedOuterJs, v: vsh, f: fsh}`
   (compact separators) -> `gzip -9` -> base64 single-line string `P`.
   Note: `j` still contains the three sentinel string literals.
8. **Assemble final HTML**: identical shell/CSS to original (CSS minified), plus
   one small bootstrap `<script>` (~400 B):
   - `atob(P)` -> `Uint8Array`
   - `new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))`
   - read text, `JSON.parse`
   - substitute sentinels in `j`: `@@BLOB@@` -> rebuilt blob b64, `@@VSH@@`/`@@FSH@@`
     -> shader sources (JSON-encode when substituting)
   - execute via a dynamic `<script>` element whose `.text` is the substituted
     code (preserves global-scope semantics of the original inline script)
9. **Verify**:
   - byte size < 65,536
   - every JS artifact passes `node --check` / parses via `new Function`
   - simulate the bootstrap in Node 24 (has `DecompressionStream`) to prove the
     payload round-trips and the substituted main script parses
   - open in a real browser (if available) and confirm no console errors and
     canvas/WebGL initializes
10. Only after verification, replace `bde-player.html` with the minimized file
    (keep a backup `bde-player.orig.html`).

## Risks / mitigations

- **Async execution**: original inline script ran synchronously; the bootstrap
  defers execution until after inflate. Mitigation: script sits at end of body,
  so DOM is fully parsed; verify no dependency on synchronous ordering
  (`document.currentScript`, `document.write`, external inline consumers).
- **Sentinel collision**: sentinels must not occur naturally in the code;
  verify uniqueness before substitution.
- **Browser support**: `DecompressionStream` requires Chrome/Edge 80+,
  Firefox 113+, Safari 16.4+ (all evergreen browsers since ~2023). Accepted per
  "standard web browser" requirement.
