import { describe, expect, it } from 'vitest';
import { parseTitle, scoreCand } from './lyricsSearch';

describe('lyrics search', () => {
  const title = "蕭秉治Xiao Bing Chih [ 想悄悄住進你的靈魂 I'm So Into You ] Official Music Video | 電視劇《難哄 The First Frost》守護曲";
  it('pulls the artist and song out of an MV title', () => {
    const p = parseTitle(title);
    expect(p.artists).toContain('蕭秉治');
    expect(p.songs).toContain('想悄悄住進你的靈魂');
  });
  it('prefers the right song over another song from the same drama', () => {
    const p = parseTitle(title);
    const right = scoreCand({ artistName: '萧秉治', trackName: '想悄悄住进你的灵魂（电视剧《难哄》守护曲）', duration: 241, syncedLyrics: 'x' }, p.artists, p.songs, 264);
    const wrong = scoreCand({ artistName: 'Various Artists', trackName: '像晴天像雨天（電視劇《難哄》心動曲）', duration: 230, syncedLyrics: 'x' }, p.artists, p.songs, 264);
    expect(right).toBeGreaterThan(2.2);
    expect(wrong).toBe(0);
  });
  it('reads "artist - song" titles', () => {
    const p = parseTitle('周杰倫 Jay Chou【晴天 Sunny Day】Official MV');
    expect(p.songs).toContain('晴天');
    const r = parseTitle('李佳薇 Jess Lee〈甲乙丙丁 Strangers〉Official Lyric Video');
    expect(r.songs).toContain('甲乙丙丁');
    expect(r.artists).toContain('李佳薇');
    const q = parseTitle('告五人 Accusefive - 愛人錯過 Official Music Video');
    expect(q.songs).toContain('愛人錯過');
  });
});

describe('a song from the charts', () => {
  it('finds the lyrics by the known singer, not another song with the same name', async () => {
    const lrc = (w: string) => Array.from({ length: 10 }, (_, i) => `[00:${String(10 + i * 4).padStart(2, '0')}.00]${w}${i}`).join('\n');
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(decodeURIComponent(String(u)));
      const body = String(u).includes('lrclib')
        ? [
            { artistName: '別人', trackName: '擱淺', duration: 200, syncedLyrics: lrc('錯') },
            { artistName: '周杰倫 Jay Chou', trackName: '擱淺', duration: 238, syncedLyrics: lrc('對') },
            { artistName: '周杰倫', trackName: '擱淺 (Live)', duration: 251, syncedLyrics: lrc('現場') },
          ]
        : { songs: [] };
      return { ok: true, json: async () => body } as Response;
    }) as typeof fetch;
    try {
      const { findLyrics } = await import('./lyricsSearch');
      const hit = await findLyrics('擱淺 · 周杰倫', 240, { artist: '周杰倫', name: '擱淺' });
      expect(hit!.lrc).toContain('對0');
      expect(hit!.duration).toBe(238);
      expect(calls[0]).toContain('track_name=擱淺');
      expect(calls[0]).toContain('artist_name=周杰倫');
      // "these are the wrong lyrics": the next file, still this singer's
      const other = await findLyrics('擱淺 · 周杰倫', 240, { artist: '周杰倫', name: '擱淺' }, 1);
      expect(other!.lrc).toContain('現場0');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('credits', () => {
  it('drops the people who made the record, keeps what is sung', async () => {
    const lines = ['[00:00.00]製作團隊 : 撥片音樂', '[00:01.00]混音/母帶 : 張鳴利', '[00:02.00]製作人 Producer : 陳皓宇', '[00:03.00]Bass : 蘇虹文', '[00:04.00]詞 : 阿信', '[00:05.00]【本作品宣告，著作權權利保留】', ...Array.from({ length: 9 }, (_, i) => `[00:${10 + i * 3}.00]我說：愛你${i}`)];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => ({ ok: true, json: async () => (String(u).includes('lrclib') ? [{ artistName: '甲', trackName: '乙丙', duration: 100, syncedLyrics: lines.join('\n') }] : { songs: [] }) }) as Response) as typeof fetch;
    try {
      const { findLyrics } = await import('./lyricsSearch');
      const hit = await findLyrics('x', 100, { artist: '甲', name: '乙丙' });
      expect(hit!.lrc).not.toMatch(/撥片|張鳴利|陳皓宇|蘇虹文|阿信|宣告/);
      expect(hit!.lrc).toContain('我說：愛你0');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('nothing under the chart name', () => {
  it('does not settle for another song', async () => {
    const lrc = Array.from({ length: 10 }, (_, i) => `[00:${10 + i * 4}.00]line ${i}`).join('\n');
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => ({ ok: true, json: async () => (String(u).includes('lrclib') ? [{ artistName: 'RHINO', trackName: 'I Love You', duration: 262, syncedLyrics: lrc }] : { songs: [] }) }) as Response) as typeof fetch;
    try {
      const { findLyrics } = await import('./lyricsSearch');
      expect(await findLyrics('蕭秉治 [ 我愛你一句話 I Love You ] Official MV', 275, { artist: '蕭秉治', name: '我愛你一句話' })).toBeNull();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('nameFit', () => {
  it('is not fooled by the same characters in another order, or stray Latin letters', async () => {
    const { nameFit, scoreCand } = await import('./lyricsSearch');
    expect(nameFit('我愛你一句話', '說出你聽過最假的一句話：我聽過的是«我永遠只愛你一個»')).toBeLessThan(0.6);
    expect(nameFit('Jay Chou', '羅可Lorkin, CranetheBlue, Kevin羅凱文')).toBeLessThan(0.5);
    expect(nameFit('Jay Chou', '周杰倫 Jay Chou')).toBe(1);
    expect(nameFit('甲乙丙丁', '甲乙丙丁 (你我怎麼兩清)')).toBe(1);
    // the singer is known: a cover of another length does not pass, the singer's own does
    const cover = scoreCand({ artistName: '羅可Lorkin, CranetheBlue', trackName: '擱淺', duration: 205, syncedLyrics: 'x' }, ['周杰倫', 'Jay Chou'], ['擱淺'], 269, true);
    const own = scoreCand({ artistName: 'Jay Chou', trackName: '擱淺', duration: 236, syncedLyrics: 'x' }, ['周杰倫', 'Jay Chou'], ['擱淺'], 269, true);
    expect(cover).toBeLessThan(2.2);
    expect(own).toBeGreaterThan(cover);
  });
});
