// Finding synced lyrics for a YouTube MV title on LRCLIB (free, public): pull the artist and the song
// name out of the title, ask for both, score every answer and only accept one that matches the song.

export interface LrcHit {
  lrc: string;
  name: string;
  duration: number;
}

const BR_SONG = /[\[【「『](.+?)[\]】」』]/g; // brackets that usually hold the song name
const NOISE = /official\s*(music\s*)?video|music video|lyrics?\s*video|\bm\/?v\b|\bmv\b|official|官方|完整版|動態歌詞|歌詞版?|高音質|4k|hd|\bhq\b|ktv|伴奏|karaoke|首播|cover/gi;
const cjk = (s: string) => (s.match(/[㐀-鿿豈-﫿]+/g) ?? []).join('');
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** Shared characters, order ignored: tolerant of 繁/简 (most characters are the same in both). */
export function overlap(a: string, b: string): number {
  const A = [...norm(a)];
  const B = [...norm(b)];
  if (!A.length || !B.length) return 0;
  const bag = new Map<string, number>();
  for (const c of B) bag.set(c, (bag.get(c) ?? 0) + 1);
  let n = 0;
  for (const c of A) {
    const k = bag.get(c) ?? 0;
    if (k) {
      n++;
      bag.set(c, k - 1);
    }
  }
  return n / A.length;
}

/** Artist and song-name guesses from a title like "蕭秉治Xiao Bing Chih [ 想悄悄住進你的靈魂 I'm So Into You ] Official MV | 電視劇《難哄》". */
export function parseTitle(title: string): { artists: string[]; songs: string[] } {
  const main = title.split(/[|｜]/)[0];
  const songs: string[] = [];
  for (const m of main.matchAll(BR_SONG)) {
    const inner = m[1].replace(NOISE, ' ').trim();
    if (!inner) continue;
    const c = cjk(inner);
    if (c) songs.push(c);
    const latin = inner.replace(/[㐀-鿿豈-﫿]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (latin.length > 2) songs.push(latin);
  }
  let artistPart = main.replace(BR_SONG, ' ');
  let dashSong = '';
  const dash = artistPart.split(/\s[-–—]\s|[-–—]/);
  if (dash.length > 1) {
    artistPart = dash[0];
    dashSong = dash.slice(1).join(' ');
  }
  artistPart = artistPart.replace(/《.*?》|\(.*?\)|（.*?）/g, ' ').replace(NOISE, ' ').trim();
  if (dashSong) {
    const d = dashSong.replace(/《.*?》|\(.*?\)|（.*?）/g, ' ').replace(NOISE, ' ').trim();
    if (cjk(d)) songs.push(cjk(d));
    else if (d) songs.push(d);
  }
  const artists: string[] = [];
  if (cjk(artistPart)) artists.push(cjk(artistPart));
  const latinA = artistPart.replace(/[㐀-鿿豈-﫿]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (latinA.length > 1) artists.push(latinA);
  // no brackets and no dash: the whole cleaned title is all we have
  if (!songs.length) {
    const whole = main.replace(/《.*?》/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (whole) songs.push(whole);
  }
  return { artists: [...new Set(artists)], songs: [...new Set(songs)] };
}

interface Cand {
  artistName: string;
  trackName: string;
  duration: number;
  syncedLyrics: string | null;
}

/** How well an LRCLIB answer fits: the song name must match; artist and length add confidence. */
export function scoreCand(c: Cand, artists: string[], songs: string[], videoDur: number): number {
  // the track name without its "(電視劇《…》插曲)" style notes
  const track = c.trackName.replace(/[(（].*?[)）]/g, ' ');
  let song = 0;
  for (const s of songs) song = Math.max(song, overlap(s, track), overlap(track, s) * 0.9);
  if (song < 0.6) return 0;
  let artist = 0;
  for (const a of artists) artist = Math.max(artist, overlap(a, c.artistName));
  let sc = song * 3 + artist * 2;
  if (/various artists/i.test(c.artistName)) sc -= 0.5;
  // an MV is usually as long as the song or longer (intro, story); much shorter means another version
  if (videoDur > 0 && c.duration > 0) {
    const d = videoDur - c.duration;
    if (d >= -8 && d <= 45) sc += 1;
    else if (d < -20) sc -= 1.5;
  }
  return sc;
}

export async function findLyrics(videoTitle: string, videoDur = 0): Promise<LrcHit | null> {
  const { artists, songs } = parseTitle(videoTitle);
  const queries: string[] = [];
  for (const s of songs) {
    for (const a of artists) queries.push(`${a} ${s}`);
    queries.push(s);
  }
  const seen = new Map<string, Cand>();
  for (const q of [...new Set(queries)].slice(0, 6)) {
    try {
      const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      for (const c of (await r.json()) as Cand[]) if (c.syncedLyrics) seen.set(`${c.artistName}|${c.trackName}|${c.duration}`, c);
    } catch {
      /* offline or blocked */
    }
    if (seen.size >= 8) break;
  }
  let best: Cand | null = null;
  let bestSc = 0;
  for (const c of seen.values()) {
    const sc = scoreCand(c, artists, songs, videoDur);
    if (sc > bestSc) {
      bestSc = sc;
      best = c;
    }
  }
  if (!best || bestSc < 2.2) return null; // nothing that is clearly this song: better no lyrics than wrong ones
  return { lrc: best.syncedLyrics!, name: `${best.artistName} – ${best.trackName}`, duration: best.duration };
}
