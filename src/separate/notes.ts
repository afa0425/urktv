// Turns a separated lead vocal into guide notes (the grey bars) by tracking its pitch and cutting it into notes.
import { detectPitch, freqToMidi } from '../audio/pitch';
import type { LyricLine, Note } from '../core/chart';

export const NOTE_RATE = 11025; // analysis rate: enough for a voice, 4x cheaper than 44.1 kHz
const HOP = 110; // ~10 ms
const WIN = 512; // ~46 ms

/** 44.1 kHz stereo -> 11.025 kHz mono with a short low-pass so it doesn't alias. */
export function downmix4(l: Float32Array, r: Float32Array): Float32Array {
  const n = Math.floor(l.length / 4);
  const out = new Float32Array(n);
  // 7-tap triangular low-pass centred on each kept sample
  const k = [1, 2, 3, 4, 3, 2, 1];
  for (let i = 0; i < n; i++) {
    const c = i * 4;
    let s = 0;
    let w = 0;
    for (let j = 0; j < 7; j++) {
      const idx = c + j - 3;
      if (idx < 0 || idx >= l.length) continue;
      s += k[j] * (l[idx] + r[idx]);
      w += k[j];
    }
    out[i] = s / (2 * w);
  }
  return out;
}

export interface PitchTrack {
  hop: number; // seconds per frame
  midi: (number | null)[];
}

export function trackPitch(mono: Float32Array, rate = NOTE_RATE, onProgress?: (p: number) => void): PitchTrack {
  const frames = Math.max(0, Math.floor((mono.length - WIN) / HOP));
  // loudness gate relative to the song: separated vocals have a little bleed in the quiet parts
  const rmsArr = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const o = f * HOP;
    for (let i = 0; i < WIN; i++) s += mono[o + i] * mono[o + i];
    rmsArr[f] = Math.sqrt(s / WIN);
  }
  const sorted = Float32Array.from(rmsArr).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const gate = Math.max(0.004, loud * 0.12);

  const midi: (number | null)[] = new Array(frames).fill(null);
  const buf = new Float32Array(WIN);
  for (let f = 0; f < frames; f++) {
    if (rmsArr[f] < gate) continue;
    buf.set(mono.subarray(f * HOP, f * HOP + WIN));
    const p = detectPitch(buf, rate, 0.75, 0);
    if (p) midi[f] = freqToMidi(p.freq);
    if (onProgress && f % 2000 === 0) onProgress(f / frames);
  }
  // 5-frame median over voiced frames removes octave blips
  const out = midi.slice();
  for (let f = 2; f < frames - 2; f++) {
    if (midi[f] === null) continue;
    const w = [midi[f - 2], midi[f - 1], midi[f], midi[f + 1], midi[f + 2]].filter((v): v is number => v !== null);
    if (w.length >= 3) out[f] = w.sort((a, b) => a - b)[w.length >> 1];
  }
  return { hop: HOP / rate, midi: out };
}

/**
 * Cuts a pitch track into notes. Each frame snaps to a semitone with hysteresis (it stays on the current
 * semitone until the voice is clearly closer to another), so held notes with vibrato stay one note and
 * runs and slides become short stepped notes instead of disappearing.
 */
export function segmentNotes(track: PitchTrack, minDur = 0.08): Note[] {
  const { hop, midi } = track;
  const notes: Note[] = [];
  let cur: number | null = null; // current semitone
  let start = 0;
  let last = -1; // last voiced frame of the current run
  const flush = () => {
    if (cur !== null && last >= start && (last + 1 - start) * hop >= minDur) {
      notes.push({ start: start * hop, end: (last + 1) * hop, midi: cur, text: '', kind: 'normal', line: 0 });
    }
    cur = null;
  };
  for (let f = 0; f < midi.length; f++) {
    const m = midi[f];
    if (m === null) {
      if (cur !== null && f - last > 3) flush();
      continue;
    }
    if (cur === null) {
      cur = Math.round(m);
      start = f;
    } else if (Math.abs(m - cur) > 0.65) {
      flush();
      cur = Math.round(m);
      start = f;
    }
    last = f;
  }
  flush();

  // merge neighbours on the same pitch with a tiny gap (vibrato dips, consonants)
  const merged: Note[] = [];
  for (const n of notes) {
    const p = merged[merged.length - 1];
    if (p && p.midi === n.midi && n.start - p.end < 0.08) p.end = n.end;
    else merged.push({ ...n });
  }
  return merged;
}

/** Groups notes into phrases (a pause of 0.9 s or more starts a new line). */
export function phraseLines(notes: Note[]): LyricLine[] {
  const lines: LyricLine[] = [];
  let line = -1;
  let lastEnd = -Infinity;
  for (const n of notes) {
    if (n.start - lastEnd >= 0.9) {
      line++;
      lines.push({ start: n.start, end: n.end, text: '', parts: [] });
    }
    n.line = line;
    lines[line].end = n.end;
    lastEnd = n.end;
  }
  return lines;
}
