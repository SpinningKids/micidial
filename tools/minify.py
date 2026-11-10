#!/usr/bin/env python3
"""Rebuild bde-player.html (or any iteration of it) into a <64 KiB single-file HTML.

Pipeline (lossless to behavior):
  1. Extract CSS + JS from the input HTML.
  2. Replace the three big string literals (embedded base64-gzip blob, vertex
     shader, fragment shader) with unique sentinels.
  3. Terser-minify the outer JS.
  4. Unwrap the embedded blob -> terser the inner engine JS -> re-gzip -9.
  5. Pack {outer js, shaders, new blob} into one gzipped base64 runtime payload.
  6. Reassemble the HTML with a small DecompressionStream('gzip') bootstrap.

Usage:
  python tools/minify.py [INPUT_HTML] [-o OUTPUT_HTML]

Defaults: INPUT_HTML = bde-player.orig.html if present else bde-player.html,
          OUTPUT     = bde-player.min.html (never overwrites the input).
Requires: node + npx terser (npx will fetch it on first use).
"""
import argparse
import base64
import gzip
import json
import os
import shutil
import subprocess
import sys

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build')
TOOLS = os.path.dirname(os.path.abspath(__file__))

# Sentinel tokens: control chars that cannot occur in the source and do NOT
# contain the search markers used to locate the literals.
TOK_B, TOK_V, TOK_F = '\x01B\x01', '\x01V\x01', '\x01F\x01'


def strip_literal(js: str, marker: str, token: str):
    """Replace the string literal containing `marker` with `token` (quoted)."""
    i = js.find(marker)
    assert i >= 0, f'marker not found: {marker!r}'
    start = js.rfind('"', 0, i)
    end = start + 1
    while True:
        end = js.find('"', end + 1)
        assert end != -1, f'unterminated literal for {marker!r}'
        if js[end - 1] != '\\':
            break
    return js[:start] + '"' + token + '"' + js[end + 1:], js[start + 1:end]


def run(cmd, **kw):
    r = subprocess.run(cmd, cwd=kw.pop('cwd', BUILD), check=True,
                       capture_output=True, text=True, shell=(os.name == 'nt'), **kw)
    return r.stdout


def terser(src_name, out_name):
    run(f'npx --yes terser {src_name} -c -m --format ascii_only=true -o {out_name}')
    return open(os.path.join(BUILD, out_name), encoding='utf-8').read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', nargs='?')
    ap.add_argument('-o', '--output')
    args = ap.parse_args()

    root = os.path.dirname(TOOLS)
    inp = args.input or os.path.join(
        root, 'bde-player.orig.html' if os.path.exists(os.path.join(root, 'bde-player.orig.html'))
        else 'bde-player.html')
    out = args.output or os.path.splitext(inp)[0] + '.min.html'

    s = open(inp, encoding='utf-8').read()
    orig_size = len(s.encode('utf-8'))

    # --- extract structure ---
    i, j = s.find('<style>'), s.find('</style>')
    k, l = s.find('<script>'), s.find('</script>')
    assert -1 not in (i, j, k, l), 'input does not match expected single style/script layout'
    css, js = s[i + 7:j], s[k + 8:l]
    head, mid, tail = s[:i], s[j + 8:k], s[l + 9:]

    shutil.rmtree(BUILD, onerror=lambda f, p, e: (os.chmod(p, 0o777), f(p))
                  if os.name == 'nt' and e[0] == PermissionError else None) if os.path.isdir(BUILD) else None
    if os.path.isdir(BUILD):
        import time
        for _ in range(5):
            time.sleep(0.5)
            shutil.rmtree(BUILD, ignore_errors=True)
            if not os.path.isdir(BUILD):
                break
        else:
            print('warning: could not fully clean build dir', file=sys.stderr)
    os.makedirs(BUILD, exist_ok=True)

    # --- sentinelize ---
    sent, blob_b64 = strip_literal(js, 'H4sIAAAAAAAA', TOK_B)
    tmp, vsh_raw = strip_literal(sent, '#version 300 es', TOK_V)
    sent, fsh_raw = strip_literal(tmp, '#version 300 es', TOK_F)
    for t in (TOK_B, TOK_V, TOK_F):
        assert sent.count(t) == 1, f'sentinel {t!r} not unique'
    open(os.path.join(BUILD, 'outer.sentinel.js'), 'w', encoding='utf-8').write(sent)
    json.dump({'blob': blob_b64, 'vsh': vsh_raw, 'fsh': fsh_raw},
              open(os.path.join(BUILD, 'meta.json'), 'w', encoding='utf-8'))

    # --- minify outer JS (sentinels survive as \xNN escapes) ---
    outer_min = terser('outer.sentinel.js', 'outer.sentinel.min.js')

    # --- rebuild embedded blob with minified engine ---
    eng_src, project = json.loads(gzip.decompress(base64.b64decode(blob_b64)))
    open(os.path.join(BUILD, 'engine.js'), 'w', encoding='utf-8').write(eng_src)
    eng_min = terser('engine.js', 'engine.min.js')
    new_blob = base64.b64encode(gzip.compress(
        json.dumps([eng_min, project], separators=(',', ':')).encode(), 9, mtime=0)).decode()

    # --- shader raw literal text -> true runtime strings (via node eval) ---
    json.dump({'vsh': vsh_raw, 'fsh': fsh_raw},
              open(os.path.join(BUILD, 'rawlit.json'), 'w', encoding='utf-8'))
    run(f'node "{os.path.join(TOOLS, "eval_literals.js")}"')
    lit = json.load(open(os.path.join(BUILD, 'runtime.json'), encoding='utf-8'))
    # store runtime values in meta so verifiers can compare against them
    meta = json.load(open(os.path.join(BUILD, 'meta.json'), encoding='utf-8'))
    meta.update(vsh=lit['vsh'], fsh=lit['fsh'])
    json.dump(meta, open(os.path.join(BUILD, 'meta.json'), 'w', encoding='utf-8'))

    # --- single gzip payload for everything dynamic ---
    payload = base64.b64encode(gzip.compress(json.dumps({
        'j': outer_min, 'v': lit['vsh'], 'f': lit['fsh'], 'b': new_blob,
    }, separators=(',', ':')).encode(), 9, mtime=0)).decode()

    # --- bootstrap: inflate, splice quoted values over quoted sentinels, execute ---
    boot = (
        '(async()=>{'
        'const t=await new Response(new Response('
        'Uint8Array.from(atob("' + payload + '"),a=>a.charCodeAt(0))'
        ').body.pipeThrough(new DecompressionStream("gzip"))).text(),o=JSON.parse(t),'
        's=document.createElement("script");'
        "s.textContent=o.j.split('\"\\\\x01B\\\\x01\"').join(JSON.stringify(o.b))"
        ".split('\"\\\\x01V\\\\x01\"').join(JSON.stringify(o.v))"
        ".split('\"\\\\x01F\\\\x01\"').join(JSON.stringify(o.f));"
        'document.body.appendChild(s)})()'
    )

    html = head + '<style>' + css + '</style>' + mid + '<script>' + boot + '</script>' + tail
    open(out, 'w', encoding='utf-8').write(html)
    new_size = len(html.encode('utf-8'))
    print(f'{inp}: {orig_size} bytes')
    print(f'{out}: {new_size} bytes ({100 - new_size * 100 // orig_size}% smaller)')
    print('under 65536:', new_size < 65536)


if __name__ == '__main__':
    main()
