// Run with Node.js and Playwright installed: node tests/camera-flow.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, '../dist', req.url === '/' ? 'index.html' : req.url);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.readFile(file, (error, data) => { res.statusCode = error ? 404 : 200; res.end(error ? '' : data); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.testScene = 'background';
      navigator.mediaDevices.getUserMedia = async () => {
        if (window.denyCamera) throw new DOMException('Denied', 'NotAllowedError');
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d');
        function draw() {
          ctx.fillStyle = '#c8a078'; ctx.fillRect(0, 0, 640, 360);
          if (window.testScene === 'cloak') {
            ctx.fillStyle = '#1e64ff'; ctx.fillRect(160, 90, 320, 180);
            ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 80, 80);
          }
          requestAnimationFrame(draw);
        }
        draw();
        return canvas.captureStream(30);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await page.locator('#captureBar').isVisible(), false);
    assert.equal(await page.locator('#colorControls').isVisible(), false);
    await page.click('#startButton');
    await page.waitForFunction(() => !document.querySelector('#captureButton').disabled);
    assert.equal(await page.locator('#captureLabel').textContent(), 'Capture background');
    await page.click('#captureButton');
    for (const id of ['captureButton', 'switchButton', 'resetButton']) {
      assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} locked during countdown`);
    }
    assert.equal(await page.locator('#resultDialog').isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#captureLabel').textContent === 'Take photo');
    assert.equal(await page.locator('#colorControls').isVisible(), true);
    assert.equal(await page.locator('#advancedSettings').getAttribute('open'), null);
    await page.evaluate(() => { window.testScene = 'cloak'; });
    await page.waitForTimeout(200);
    await page.click('#captureButton');
    await page.waitForFunction(() => document.querySelector('#resultDialog').open);
    const pixels = await page.evaluate(async () => {
      const img = document.querySelector('#resultImage'); await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return [Array.from(ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data),
        Array.from(ctx.getImageData(c.width - 10, 10, 1, 1).data)];
    });
    assert.ok(Math.abs(pixels[0][0] - 200) < 8 && Math.abs(pixels[0][1] - 160) < 8, 'Photo replaces blue cloak with saved background');
    assert.ok(pixels[1][1] > 240 && pixels[1][0] < 15, 'Photo preserves the live non-cloak area');
    const download = page.waitForEvent('download'); await page.click('#downloadButton');
    assert.match((await download).suggestedFilename(), /^magic-camera-.*\.png$/);
    await page.click('#closeResult');
    await page.evaluate(() => { window.testScene = 'background'; });
    await page.click('#backgroundButton');
    await page.waitForFunction(() => !document.querySelector('#captureButton').disabled);
    assert.equal(await page.locator('#captureLabel').textContent(), 'Take photo');
    await page.click('#switchButton');
    await page.waitForFunction(() => !document.querySelector('#captureButton').disabled);
    assert.equal(await page.locator('#captureLabel').textContent(), 'Capture background');
    assert.equal(await page.locator('#colorControls').isVisible(), false);
    await page.click('#captureButton');
    await page.waitForFunction(() => document.querySelector('#captureLabel').textContent === 'Take photo');
    await page.click('#resetButton');
    assert.equal(await page.locator('#captureLabel').textContent(), 'Capture background');
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.TEST_SCREENSHOT) await page.screenshot({ path: process.env.TEST_SCREENSHOT, fullPage: true });
    await page.evaluate(() => { window.denyCamera = true; });
    await page.click('#switchButton');
    await page.waitForFunction(() => !document.querySelector('#startButton').disabled);
    assert.equal(await page.locator('#startButton').isVisible(), true);
    assert.equal(await page.locator('#captureBar').isVisible(), false);
    await page.evaluate(() => { window.denyCamera = false; });
    await page.click('#startButton');
    await page.waitForFunction(() => !document.querySelector('#captureButton').disabled);
    assert.deepEqual(errors, []);
    console.log('PASS: guided capture, action locks, composited PNG, download, retake, switch, reset, responsive layouts, permission recovery.');
  } finally {
    await browser?.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
