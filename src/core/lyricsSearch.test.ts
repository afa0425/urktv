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
    const q = parseTitle('告五人 Accusefive - 愛人錯過 Official Music Video');
    expect(q.songs).toContain('愛人錯過');
  });
});
