// The high-quality backing kept on this computer: sing a song once (the background pass fills the
// store), sing it again (the kept backing is used). Real extension, fake YouTube.
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const errs = [];
  const diag = async (p) => { await p.locator('details.diag summary').click().catch(() => {}); const d = await p.locator('.diag-pre').innerText().catch(() => ''); await p.locator('details.diag summary').click().catch(() => {}); return d.split('\n').filter((l) => /高品質伴奏|引擎|錯誤/.test(l)).join(' | '); };
  for (const round of [1, 2]) {
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:4173/?fakeyt&bgalways#');
    await p.waitForSelector('.h-search input');
    await p.fill('.h-search input', 'https://youtu.be/abcdefghijk');
    await p.locator('.h-search button').click();
    await p.waitForSelector('.lead-box', { timeout: 20000 });
    await p.waitForTimeout(2500);
    await p.getByRole('button', { name: /開始演唱/ }).first().click();
    for (const sec of round === 1 ? [15, 30, 45, 60, 75, 90] : [8, 16, 24]) {
      await p.waitForTimeout((round === 1 ? 15 : 8) * 1000);
      console.log(`round ${round} +${sec}s`, await diag(p));
    }
    if (round === 2) console.log('kept line:', await p.locator('.hq-kept').innerText().catch(() => '(none)'));
    await p.getByRole('button', { name: /離開/ }).click().catch(() => {});
    await p.waitForTimeout(3000);
    await p.close();
  }
  console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
