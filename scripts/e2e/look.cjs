// A picture of the singing screen with everything on it: real extension, fake YouTube, lyrics.
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const [out, w, h] = [process.argv[2] || '/tmp/urktv-e2e/look.png', Number(process.argv[3] || 1440), Number(process.argv[4] || 900)];
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: w, height: h }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const lrc = ['[00:02.00]這是第一句測試歌詞', '[00:06.00]第二句會從右邊出來', '[00:10.00]看看掃字的效果好不好', '[00:14.00]每一句穩穩地亮起來', '[00:18.00]最後再唱一句就結束', '[00:22.00]謝謝你來唱歌', '[00:25.00]再會', '[00:27.00]下次見'].join('\n');
  await ctx.addInitScript((lrc) => { localStorage.setItem('hs.charts', JSON.stringify({ abcdefghijk: { raw: lrc, kind: 'lrc', offsetMs: 0, transpose: 0, auto: 4, name: '測試歌', dur: 30, locked: true } })); }, lrc);
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:4173/?fakeyt#');
  await p.waitForSelector('.h-search input');
  await p.fill('.h-search input', 'https://youtu.be/abcdefghijk');
  await p.locator('.h-search button').click();
  await p.waitForSelector('.lead-box', { timeout: 20000 });
  await p.waitForTimeout(2000);
  await p.screenshot({ path: out.replace('.png', '-ready.png') });
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  await p.waitForTimeout(Number(process.argv[5] || 17000));
  await p.screenshot({ path: out });
  console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
