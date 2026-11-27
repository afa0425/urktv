const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto((process.env.SITE_URL || 'http://localhost:4173') + '/?debug'); await p.waitForTimeout(1500);
  // the stage module loads with the app; titles as they appear on YouTube
  const titles = [
    ['張遠 Bird Zhang《看著我的眼睛說》Official Music Video', 230],
    ['黃乙玲 Huang Yee-ling【愛到才知痛】Official Music Video', 290],
    ['李千娜 Nana Lee【心花開】Official Music Video', 250],
    ['陳華 HuaChen【我的貓會後空翻】Official Music Video', 240],
    ['琳誼 Ring【憨膽】Official Music Video', 230],
    ['麋先生 MixerX 聖皓 - 鹹酸苦汫 Official Music Video', 260],
    ['周杰倫 Jay Chou【擱淺 Step Aside】-Official Music Video', 240],
    ['李佳薇 Jess Lee〈甲乙丙丁 Strangers〉Official Lyric Video', 211],
  ];
  for (const [t, d] of titles) {
    const r = await p.evaluate(async ([t, d]) => {
      const f = window.urktvFindLyrics;
      if (!f) return 'no hook';
      const h = await f(t, d);
      return h ? h.name + ' | ' + (h.lrc.split('\n').filter((l) => l.replace(/\[[^\]]*\]/g, '').trim())[3] || '') : 'NONE';
    }, [t, d]);
    console.log(t.slice(0, 26).padEnd(26), '->', r);
  }
  await b.close();
})();
