// Helper for minify.py: convert raw JS string-literal contents (as they appear
// between the quotes in source) into their true runtime values.
// Input:  <script dir>/build/rawlit.json   {vsh, fsh}  (raw text, no quotes)
// Output: <script dir>/build/runtime.json  {vsh, fsh}  (actual string values)
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'build');
const r = JSON.parse(fs.readFileSync(path.join(dir, 'rawlit.json'), 'utf-8'));
// Evaluate exactly as the original inline script would have.
const ev = raw => new Function('return "' + raw + '";')();
fs.writeFileSync(path.join(dir, 'runtime.json'),
  JSON.stringify({ vsh: ev(r.vsh), fsh: ev(r.fsh) }));
