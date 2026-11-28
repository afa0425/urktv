// Head start + the mid-weight backing swapped in live: open a song, wait on the ready screen (the lead
// runs ahead), press start, and see how much of the song was played with the mid-weight backing.
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const wait = Number(process.argv[2] || 12000);
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const errs = [];
  const p = await ctx.newPage();
  p.on('pageerror', e => errs.push(e.message));
  const diag = async () => { await p.locator('details.diag summary').click().catch(() => {}); const d = await p.locator('.diag-pre').innerText().catch(() => ''); await p.locator('details.diag summary').click().catch(() => {}); return d.split('\n').filter((l) => /乾淨伴奏|引擎：|原版小視窗|主畫面|錯誤/.test(l)).join(' | '); };
  await p.goto('http://localhost:4173/?fakeyt#');
  await p.waitForSelector('.h-search input');
  await p.fill('.h-search input', 'https://youtu.be/abcdefghijk');
  await p.locator('.h-search button').click();
  await p.waitForSelector('.lead-box', { timeout: 20000 });
  await p.waitForTimeout(wait);
  console.log('before start:', await diag());
  const t0 = Date.now();
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  for (let i = 0; i < 40; i++) { await p.waitForTimeout(100); if (await p.evaluate(() => /播放中/.test(document.querySelector('.diag-pre')?.textContent?.split('\n')[2] || ''))) break; }
  console.log('picture started after ms:', Date.now() - t0);
  for (const sec of [5, 10, 15]) { await p.waitForTimeout(5000); console.log(`+${sec}s`, await diag()); }
  console.log('line:', await p.locator('.hq-kept').innerText().catch(() => '(none)'));
  await p.screenshot({ path: '/tmp/urktv-e2e/swap.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
