// Browser-level lossless check: collect every GLSL source passed to
// shaderSource() in headless Chromium for the original and minified files,
// then diff them. Byte-identical => GPU-side content is preserved.
// Usage: node tools/glsl_diff.js <origHtml> [minHtml]
const path = require('path');
const { chromium } = require('playwright');

async function collect(file) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.addInitScript(() => {
    window.__srcs = [];
    const patch = proto => {
      const o = proto.shaderSource;
      proto.shaderSource = function(p, s) {
        window.__srcs.push(String(s));
        return o.call(this, p, s);
      };
    };
    patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  });
  await page.goto('file:///' + file.split('\\').join('/'));
  await page.waitForTimeout(800);
  try { await page.locator('#start').click({ timeout: 3000 }); } catch (e) {}
  await page.waitForTimeout(2500);
  const srcs = await page.evaluate(() => window.__srcs);
  await browser.close();
  return srcs;
}

(async () => {
  const root = path.dirname(__dirname);
  const origPath = process.argv[2] || path.join(root, 'bde-player.orig.html');
  const minPath = process.argv[3] || path.join(root, 'bde-player.min.html');
  const a = await collect(origPath);
  const b = await collect(minPath);
  console.log('shader count orig/min:', a.length, '/', b.length);
  const same = a.length === b.length && a.every((s, i) => s === b[i]);
  if (!same) a.forEach((s, i) => {
    if (b[i] !== s) console.log('DIFF at', i, 'len', s.length, 'vs', b[i] && b[i].length);
  });
  console.log(same ? 'PASS: all compiled GLSL byte-identical' : 'FAIL');
  process.exit(same ? 0 : 1);
})();
