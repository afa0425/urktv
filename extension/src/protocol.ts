// Messages between the URKTV page, the extension and the YouTube player frames.
// Audio never leaves this computer: the tap sends samples to the offscreen page, which plays the backing.

export const PAGE = 'urktv-page';
export const EXT = 'urktv-ext';

/** page -> extension */
export type PageMsg =
  | { type: 'hello' }
  | { type: 'consent'; ok: boolean }
  | { type: 'start'; lead: number; vocal: number; mode: 'auto' | 'ai' | 'lite' | 'classic'; modelUrl: string; ortBase: string; model: string; liteBase?: string }
  | { type: 'clock'; t: number; playing: boolean } // main (visible, muted) player's time
  | { type: 'vocal'; level: number }
  | { type: 'stop' };

/** extension -> page */
export type ExtMsg =
  | { type: 'ready'; version: string; consent: boolean }
  | { type: 'pitch'; t: number; hop: number; midi: (number | null)[] } // separated vocal's pitch, ahead of the picture
  | { type: 'status'; state: 'loading' | 'running' | 'fallback' | 'error' | 'lost'; mode?: string; speed?: number; buffered?: number; message?: string };

/** tap (YouTube frame) -> offscreen: one block of the lead player's audio */
export interface TapBlock {
  type: 'tap';
  t: number; // media time of the first sample (seconds)
  rate: number;
  l: string; // base64 int16
  r: string;
}

export function encode16(x: Float32Array): string {
  const a = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) a[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  const b = new Uint8Array(a.buffer);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decode16(s: string): Float32Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  const a = new Int16Array(b.buffer);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] / 32767;
  return out;
}
