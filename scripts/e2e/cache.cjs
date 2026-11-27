// Sing a song, leave, come back: are the gray bars there before the backing has even started?
const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1360, height: 900 }, locale: 'zh-TW',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  await ctx.grantPermissions(['microphone'], { origin: 'http://localhost:4173' });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const open = async (r) => {
    await p.goto('http://localhost:4173/?fakeyt&debug&r=' + r + '#');
    await p.fill('.h-search input', 'https://youtu.be/abcdefghijk');
    await p.locator('.h-search button').click();
    await p.waitForSelector('.lead-box');
  };
  await open(1);
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  await p.waitForTimeout(20000);
  await p.getByRole('button', { name: /離開/ }).click(); // leaving saves
  await p.waitForTimeout(1000);
  const saved = await p.evaluate(() => new Promise((ok) => {
    const r = indexedDB.open('urktv-songs'); r.onsuccess = () => { const g = r.result.transaction('pitch').objectStore('pitch').get('v2:abcdefghijk'); g.onsuccess = () => ok(g.result ? g.result.data.length : 0); };
  }));
  console.log('frames saved after singing:', saved);
  await open(2);
  await p.waitForTimeout(800);
  console.log('notes known before starting:', await p.evaluate(() => window.urktvLive.between(0, 30).map((n) => n.start.toFixed(1)).join(' ')));
  await p.getByRole('button', { name: /開始演唱/ }).first().click();
  await p.waitForTimeout(3000); // backing not ready yet: bars must come from the saved copy
  await p.locator('.lane-wrap').screenshot({ path: process.argv[2] });
  console.log('errors:', errs.length ? errs : 'none');
  await ctx.close();
})();
