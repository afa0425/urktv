// The real stage, the real extension, a fake YouTube (local clip in cross-origin frames).
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:4173/?fakeyt#');
  await p.waitForSelector('.h-search input');
  await p.fill('.h-search input', 'https://youtu.be/abcdefghijk');
  await p.locator('.h-search button').click();
  await p.waitForSelector('.sing-mode', { timeout: 20000 });
  await p.waitForSelector('.lead-box');
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  for (const sec of [6, 12, 18, 24, 30]) {
    if (sec === 12) { await p.getByRole('radio', { name: '🎶 伴唱' }).click(); }
    if (sec === 12) { await p.locator('.tools-more > summary').click(); await p.getByRole('button', { name: '♂ 男調' }).click(); await p.locator('.chip-btn.sfx').first().click(); await p.getByRole('button', { name: '🐿️ 可愛' }).click(); console.log('tools:', (await p.locator('.ktv-tools').innerText()).replace(/\n/g,' ')); console.log('key:', await p.locator('.key-ctl span').innerText()); }
    if (sec === 18) { console.log('engine:', JSON.stringify(await ctx.serviceWorkers()[0].evaluate(() => chrome.runtime.sendMessage({ to: 'engine-diag' })))); console.log('chooser:', (await p.locator('.sing-mode').innerText()).replace(/\n/g,' ')); }
    await p.waitForTimeout(6000);
    await p.locator('details.diag summary').click().catch(() => {});
    const d = await p.locator('.diag-pre').innerText().catch(() => '(no diag)');
    console.log(`--- ${sec}s\n` + d.split('\n').slice(1, 7).join('\n'));
    await p.locator('details.diag summary').click().catch(() => {});
  }
  await p.screenshot({path:'/tmp/urktv-e2e/chooser.png'}); console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
