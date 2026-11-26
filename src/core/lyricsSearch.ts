// Finding synced lyrics for a YouTube MV title on LRCLIB (free, public): pull the artist and the song
// name out of the title, ask for both, score every answer and only accept one that matches the song.

export interface LrcHit {
  lrc: string;
  name: string;
  duration: number;
}

const BR_SONG = /[\[【「『〈<＜«](.+?)[\]】」』〉>＞»]/g; // brackets that usually hold the song name
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
  // 《…》 is often a drama or album, but when nothing else names the song it is the song
  if (!songs.length) {
    const book = /《(.+?)》/.exec(main)?.[1]?.replace(NOISE, ' ').trim();
    if (book && cjk(book)) songs.push(cjk(book));
  }
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
  /** NetEase song id: its lyrics are fetched only if it wins */
  ne?: number;
}

/** Credits that some lyric files carry as timed lines (作词 : …): not to be sung. */
const CREDIT = /^\[[\d:.]+\]\s*(絃樂編寫|弦乐编写|配唱製作|配唱制作|作词|作詞|作曲|编曲|編曲|制作人|製作人|监制|監製|混音|母带|母帶|和声|和聲|录音|錄音|吉他|贝斯|貝斯|鼓|弦乐|弦樂|出品|发行|發行|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i;

/** Simplified → Traditional (Taiwan, with phrases); loaded only when a lyric needs it. */
let toTw: ((s: string) => string) | null = null;
async function traditional(text: string): Promise<string> {
  if (!toTw) {
    const { Converter } = await import('opencc-js/cn2t');
    toTw = Converter({ from: 'cn', to: 'twp' });
  }
  return toTw!(text);
}

async function tidy(lrc: string): Promise<string> {
  // drop credit lines and translations appended to a line ("…^English", "… / English")
  const lines = lrc
    .split('\n')
    .filter((l) => !CREDIT.test(l.trim()))
    .map((l) => l.replace(/\^.*$/, '').replace(/\s+\/\s+[A-Za-z].*$/, ''));
  return traditional(lines.join('\n'));
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
  // uploads named like videos ("【動態歌詞MV】", 『lyric quote』) are less reliable than the real track
  if (/[【『]|動態|动态|\bmv\b|歌詞版|歌词版|lyrics?/i.test(c.trackName)) sc -= 1;
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
  const uniq = [...new Set(queries)];
  const seen = new Map<string, Cand>();
  // source 1: LRCLIB (free, public, many languages)
  for (const q of uniq.slice(0, 6)) {
    try {
      const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      for (const c of (await r.json()) as Cand[]) if (c.syncedLyrics) seen.set(`L|${c.artistName}|${c.trackName}|${c.duration}`, c);
    } catch {
      /* offline or blocked */
    }
    if (seen.size >= 8) break;
  }
  // compare in Traditional Chinese: 貓/猫, 膽/胆 must count as the same character
  await traditional('');
  const tw = (c: Cand): Cand => ({ ...c, trackName: toTw!(c.trackName), artistName: toTw!(c.artistName) });
  const ranked = () =>
    [...seen.values()]
      .map((c) => ({ c, sc: scoreCand(tw(c), artists.map(toTw!), songs.map(toTw!), videoDur) }))
      .filter((x) => x.sc >= 2.2)
      .sort((a, b) => b.sc - a.sc);
  let list = ranked();
  // source 2: NetEase Cloud Music through our server (most Mandarin, Taiwanese and Cantonese songs)
  if (!list.length || list[0].sc < 3.5) {
    for (const q of uniq.slice(0, 3)) {
      try {
        const r = await fetch('/api/lyrics/search?q=' + encodeURIComponent(q));
        if (!r.ok) continue;
        const d = (await r.json()) as { songs: { id: number; trackName: string; artistName: string; duration: number }[] };
        for (const x of d.songs) seen.set(`N|${x.id}`, { ...x, syncedLyrics: null, ne: x.id });
      } catch {
        /* the site's own server is not here (local preview) */
      }
    }
    list = ranked();
  }
  // the best match that really has timed lyrics (some entries have none, or only a few lines)
  for (const { c } of list.slice(0, 4)) {
    let lrc = c.syncedLyrics;
    if (c.ne) {
      try {
        const r = await fetch('/api/lyrics/163/' + c.ne);
        lrc = r.ok ? ((await r.json()) as { lrc: string }).lrc : '';
      } catch {
        lrc = '';
      }
    }
    if (!lrc || (lrc.match(/\[\d+:\d+/g) ?? []).length < 8) continue;
    const t = tw(c);
    return { lrc: await tidy(lrc), name: `${t.artistName} – ${t.trackName}`, duration: c.duration };
  }
  return null; // nothing that is clearly this song: better no lyrics than wrong ones
}
