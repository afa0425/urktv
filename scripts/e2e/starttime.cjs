// How long from pressing start until the picture plays, first song and second song (model warm).
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  for (const round of [1, 2]) {
    await p.goto('http://localhost:4173/?fakeyt&r=' + round + '#');
    await p.waitForSelector('.h-search input');
    await p.fill('.h-search input', 'https://youtu.be/abcdefghij' + round);
    await p.locator('.h-search button').click();
    await p.waitForSelector('.lead-box');
    await p.waitForTimeout(round === 1 ? 1000 : 3000); // the singer looks at the page a moment
    const t0 = Date.now();
    await p.getByRole('button', { name: /開始演唱/ }).first().click();
    let started = 0;
    for (let i = 0; i < 300; i++) {
      await p.waitForTimeout(100);
      const d = await p.evaluate(() => document.querySelector('.seek-time')?.textContent || '');
      if (d && d !== '0:00') { started = Date.now() - t0; break; }
    }
    // time shows whole seconds: subtract the 1 s it takes to show 0:01
    console.log(`song ${round}: picture playing after ~${((started - 1000) / 1000).toFixed(1)} s`);
    await p.waitForTimeout(4000);
    await p.locator('details.diag summary').click();
    console.log((await p.locator('.diag-pre').innerText()).split('\n').filter(l => /主畫面|已播|引擎：/.test(l)).join(' / '));
  }
  console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})();
