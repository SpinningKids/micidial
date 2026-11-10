// Verifies a minified output HTML without a browser:
//  - simulates the bootstrap (inflate payload via DecompressionStream)
//  - asserts no sentinel remains and shaders match the originals exactly
//  - asserts the rebuilt blob's project data is byte-identical JSON
//  - parse-checks the fully substituted main script
// Usage: node tools/verify_html.js [outputHtml] [buildDir]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const htmlPath = process.argv[2]
  || path.join(path.dirname(__dirname), 'bde-player.min.html');
const dir = process.argv[3] || path.join(__dirname, 'build');

(async () => {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const m = html.match(/<script>(\(async.*\)\(\))<\/script>/s);
  if (!m || !m[1]) throw new Error('bootstrap script not found in output');

  let captured = null;
  global.document = {
    createElement: () => ({ set textContent(v) { captured = v; } }),
    body: { appendChild() {} },
  };
  // eslint-disable-next-line no-eval
  eval(m[1]);
  await new Promise(r => setTimeout(r, 300));
  if (!captured) throw new Error('bootstrap produced no code');
  if (captured.includes('\x01')) throw new Error('sentinel left unsubstituted');

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
  if (!captured.includes(JSON.stringify(meta.vsh))) throw new Error('vsh mismatch');
  if (!captured.includes(JSON.stringify(meta.fsh))) throw new Error('fsh mismatch');

  const mm = captured.match(/"H4sIA[A-Za-z0-9+/=]+"/);
  if (!mm) throw new Error('no blob literal found');
  const newInner = JSON.parse(zlib.gunzipSync(Buffer.from(mm[0].slice(1, -1), 'base64')).toString());
  const oldInner = JSON.parse(zlib.gunzipSync(Buffer.from(meta.blob, 'base64')).toString());
  if (typeof newInner[0] !== 'string' || !newInner[0].length) throw new Error('engine missing');
  if (JSON.stringify(newInner[1]) !== JSON.stringify(oldInner[1]))
    throw new Error('project payload mismatch');

  new Function(captured); // syntax check of the final substituted program

  console.log('OK: inflated, substituted, lossless literals verified, parses clean');
  console.log('substituted main script bytes:', Buffer.byteLength(captured));
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
