// Song sheets: what some singer's computer already worked out for an MV, shared through our server
// so nobody has to work it out again: which public lyric file fits and how far to shift it, and the
// pitch of the sung melody (the gray bars). Data about the video only: never any sound.
import type { PitchCache } from './songCache';

export interface Sheet {
  lyr: { ref: string; name: string; dur: number; off: number; votes: number; sure: boolean } | null;
  bars: { hop: number; k0: number; q: number; cover: number; data: string } | null;
}

const url = (videoId: string) => '/api/sheet/' + videoId;

export async function loadSheet(videoId: string): Promise<Sheet | null> {
  try {
    const r = await fetch(url(videoId));
    return r.ok ? ((await r.json()) as Sheet | null) : null;
  } catch {
    return null;
  }
}

/** midi × 10 per frame as base64 (little-endian 16 bit). */
export function packBars(c: PitchCache): string {
  const b = new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unpackBars(b: NonNullable<Sheet['bars']>): PitchCache {
  const s = atob(b.data);
  const u = new Uint8Array(s.length & ~1);
  for (let i = 0; i < u.length; i++) u[i] = s.charCodeAt(i);
  return { hop: b.hop, k0: b.k0, data: new Uint16Array(u.buffer) };
}

/** Share of the song (0-1) these frames cover: frames really heard over the song's length. */
export function coverage(c: PitchCache, songDur: number): number {
  let n = 0;
  for (const v of c.data) if (v) n++;
  return songDur > 0 ? Math.min(1.05, (n * c.hop) / songDur) : 0;
}

function send(videoId: string, body: unknown) {
  // also on the way out of the page: keepalive lets the request finish
  void fetch(url(videoId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

export function shareLyricTiming(videoId: string, l: { ref: string; name: string; dur: number; off: number; how: 'manual' | 'auto' }) {
  send(videoId, { lyr: l });
}

/** q: 2 = heard through the high-quality model, 1 = the light one. */
export function shareBars(videoId: string, c: PitchCache, q: 1 | 2, songDur: number) {
  const cover = coverage(c, songDur);
  if (cover < 0.7) return; // only a part of the song: not a sheet yet
  const data = packBars(c);
  if (data.length > 150 * 1024) return;
  send(videoId, { bars: { hop: c.hop, k0: c.k0, q, cover, data } });
}
