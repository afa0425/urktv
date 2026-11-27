const { chromium } = require('playwright');
(async () => {
  const ext = '/home/user/urktv/extension/dist';
  const ctx = await chromium.launchPersistentContext('', { headless: true, channel: 'chromium', viewport: { width: 1100, height: 700 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const p = await ctx.newPage();
  await p.goto('http://localhost:4173/'); await p.waitForTimeout(1500);
  console.log('home:', await p.locator('.ext-update').allInnerTexts());
  await p.screenshot({ path: process.argv[2] });
  await p.goto('http://localhost:4173/extension.html'); await p.waitForTimeout(1500);
  console.log('install page:', await p.locator('#ver').innerText());
  await ctx.close();
})();
