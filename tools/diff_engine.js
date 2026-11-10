// Differential test: original vs terser-minified audio engine from the build dir.
// Stubs the AudioWorklet scope, drives both processors with identical state,
// and compares rendered samples. Bit-identical output => minification is safe.
// Usage: node tools/diff_engine.js [buildDir]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const dir = process.argv[2] || path.join(__dirname, 'build');

function loadEngine(src) {
  let registered = null;
  const fn = new Function(
    'sampleRate', 'currentFrame', 'currentTime', 'performance',
    'AudioWorkletProcessor', 'registerProcessor',
    'Float32Array', 'Math', 'Number', 'Object', 'Array', 'Uint8Array',
    'Int32Array', 'Float64Array', 'Promise', 'console', 'JSON', 'Symbol',
    'Map', 'Set', 'Error', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    src);
  fn(48000, 0, 0, { now: () => 0 },
     class { constructor() { this.port = { postMessage() {} }; } },
     (name, cls) => { registered = { name, cls }; },
     Float32Array, Math, Number, Object, Array, Uint8Array,
     Int32Array, Float64Array, Promise, console, JSON, Symbol,
     Map, Set, Error, parseInt, parseFloat, isNaN, isFinite);
  if (!registered) throw new Error('no processor registered');
  return registered.cls;
}

function render(cls, state, blocks) {
  const inst = new cls(); // constructor installs its own port.onmessage
  inst.port.onmessage({ data: { type: 'state', state } });
  inst.port.onmessage({ data: { type: 'play' } });
  const outL = new Float32Array(128), outR = new Float32Array(128);
  const all = [];
  for (let b = 0; b < blocks; b++) {
    outL.fill(0); outR.fill(0);
    inst.process(null, [[outL, outR]]);
    all.push(Float32Array.from(outL), Float32Array.from(outR));
  }
  return all;
}

(async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
  const raw = zlib.gunzipSync(Buffer.from(meta.blob, 'base64')).toString();
  const [, project] = JSON.parse(raw);

  const orig = loadEngine(fs.readFileSync(path.join(dir, 'engine.js'), 'utf-8'));
  const mini = loadEngine(fs.readFileSync(path.join(dir, 'engine.min.js'), 'utf-8'));

  const A = render(orig, project, 200);
  const B = render(mini, project, 200);

  let diffs = 0, maxAbs = 0, nan = false;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A[i].length; j++) {
    const a = A[i][j], b = B[i][j];
    if (Number.isNaN(a) !== Number.isNaN(b)) nan = true;
    const d = Math.abs(a - b);
    if (d > 1e-9) diffs++;
    if (d > maxAbs) maxAbs = d;
  }
  console.log('blocks compared:', A.length / 2,
    '| samples differing >1e-9:', diffs,
    '| max abs diff:', maxAbs.toExponential(3), '| NaN mismatch:', nan);
  if (nan || diffs > 0) { console.log('FAIL'); process.exit(1); }
  console.log('PASS: engines bit-equivalent');
})().catch(e => { console.error('ERROR:', e.message); process.exit(2); });
