const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const code = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
  const url = `${process.env.SITE_URL || 'http://localhost:4173'}/?fakeyt#room=${code}`;
  const mk = async (name, role, cam) => {
    const c = await b.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-TW' });
    await c.grantPermissions(['microphone', 'camera'], { origin: (process.env.SITE_URL || 'http://localhost:4173') + '' });
    const p = await c.newPage(); p.errs = [];
    p.on('pageerror', (e) => p.errs.push(e.message));
    await p.goto(url);
    await p.fill('.lobby-card input[placeholder="例如：小明"]', name);
    if (role === 'watch') await p.getByRole('radio', { name: '👀 我是觀眾' }).click();
    if (cam) await p.locator('.lobby-card input[type=checkbox]').check();
    await p.getByRole('button', { name: '進入房間' }).click();
    return p;
  };
  const singer = await mk('小明', 'sing', true);
  const fan = await mk('小美', 'watch', false);
  await singer.waitForTimeout(2500);
  await singer.fill('.stage-side input[placeholder="貼 YouTube 連結"]', 'https://youtu.be/abcdefghijk');
  await singer.getByRole('button', { name: '點歌' }).click();
  await fan.locator('.chat-card input').fill('加油！');
  await fan.locator('.chat-card button').click();
  await fan.getByRole('button', { name: '送出 🔥' }).click();
  await singer.waitForTimeout(9000);
  for (const [n, p] of [['singer', singer], ['fan', fan]]) {
    const info = await p.evaluate(() => ({
      members: [...document.querySelectorAll('.member-list li')].map((x) => x.textContent),
      chat: [...document.querySelectorAll('.chat-list p')].map((x) => x.textContent),
      tiles: [...document.querySelectorAll('.tile-cam')].map((x) => x.textContent + (x.querySelector('video') ? '[video]' : '')),
      now: document.querySelector('.room-now')?.textContent,
      audioPlaying: [...document.querySelectorAll('.tile-cam audio')].map((a) => !a.paused && !!a.srcObject),
    }));
    console.log(n, JSON.stringify(info), 'errors:', p.errs.length ? p.errs : 'none');
  }
  await fan.screenshot({ path: process.argv[2] });
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
