const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + process.argv[3], '--autoplay-policy=no-user-gesture-required'] });
  const c = await b.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-TW' });
  await c.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const p = await c.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:4173/'); await p.waitForTimeout(1000);
  await p.getByRole('button', { name: /開嗓/ }).first().click();
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  await p.waitForTimeout(Number(process.argv[4] || 9000));
  await p.locator('.lane-wrap').screenshot({ path: process.argv[2] });
  console.log('errors:', errs.length ? errs : 'none');
  await b.close();
})();
