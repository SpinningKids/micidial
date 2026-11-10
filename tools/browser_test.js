// Smoke test in headless Chromium: loads the minified HTML, clicks START,
// and reports console errors/warnings and DOM state.
// Usage: node tools/browser_test.js [htmlPath]
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const root = path.dirname(__dirname);
  const file = process.argv[2] || path.join(root, 'bde-player.min.html');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning')
      logs.push(m.type() + ': ' + m.text().slice(0, 120));
  });
  await page.goto('file:///' + file.split('\\').join('/'));
  await page.waitForTimeout(1000);
  const btn = page.locator('#start');
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(4000); }
  const state = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector('canvas'),
    canvasW: document.querySelector('canvas') && document.querySelector('canvas').width,
  }));
  console.log(JSON.stringify({ errors, logs, state }, null, 2));
  const shaderErrors = logs.filter(l => l.includes('unexpected token') || l.includes('syntax error'));
  if (errors.length || shaderErrors.length) { console.log('FAIL'); process.exit(1); }
  console.log('PASS: no page errors, no GLSL compile errors');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
