// Gray bars for songs nobody prepared: the extension sends the pitch of the separated vocal a few
// seconds ahead of the picture; this turns it into bars the same way a prepared song looks.
import type { Note } from './chart';

/**
 * How far the lyrics can be off (media = lyric time + offset). The lyrics are timed to a recording of
 * `trackDur` seconds; an MV is that recording plus an intro and an ending, so the shift lies between
 * zero and the extra length. Equal lengths mean the same recording: the timing is right as it is.
 */
export function offsetBounds(videoDur: number, trackDur: number): number | [number, number] {
  if (!(videoDur > 0) || !(trackDur > 0)) return 60;
  const d = videoDur - trackDur;
  if (Math.abs(d) <= 2.5) return [-2.5, 2.5];
  return d > 0 ? [-3, d + 3] : [d - 3, 3];
}

export class LiveNotes {
  private frames = new Map<number, number | null>();
  hop = 512 / 22050;
  /** Last media time with pitch data (bars exist up to here). */
  edge = 0;
  /** Bumped whenever frames change: the bars are worked out once per change, not once per picture. */
  private ver = 0;
  private cache: { ver: number; notes: Note[] } | null = null;

  add(t: number, hop: number, midi: (number | null)[]) {
    this.hop = hop;
    const k0 = Math.round(t / hop);
    midi.forEach((m, i) => this.frames.set(k0 + i, m));
    this.edge = Math.max(this.edge, t + midi.length * hop);
    if (this.frames.size > 200000) this.frames.clear(); // a very long session: start over
    this.ver++;
  }

  /** Everything heard so far, compact (for keeping on this computer). */
  dump(): { hop: number; k0: number; data: Uint16Array } | null {
    if (!this.frames.size) return null;
    let k0 = Infinity;
    let k1 = -Infinity;
    for (const k of this.frames.keys()) {
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    const data = new Uint16Array(k1 - k0 + 1);
    for (const [k, m] of this.frames) if (m !== null) data[k - k0] = Math.round(m * 10);
    return { hop: this.hop, k0, data };
  }
  /** What an earlier time on this computer heard. */
  restore(c: { hop: number; k0: number; data: Uint16Array }) {
    this.hop = c.hop;
    c.data.forEach((v, i) => {
      if (!this.frames.has(c.k0 + i)) this.frames.set(c.k0 + i, v ? v / 10 : null);
    });
    this.edge = Math.max(this.edge, (c.k0 + c.data.length) * c.hop);
    this.ver++;
  }

  has() {
    return this.frames.size > 0;
  }

  /** Bars between a and b (media seconds). */
  between(a: number, b: number): Note[] {
    return this.all().filter((n) => n.end >= a && n.start <= b);
  }

  /**
   * Every bar heard so far. Worked out over the whole song each time new sound arrives, so a bar
   * that is on the screen keeps its place and length (only the newest second can still grow).
   */
  all(): Note[] {
    if (this.cache?.ver === this.ver) return this.cache.notes;
    const notes = this.segment();
    this.cache = { ver: this.ver, notes };
    return notes;
  }

  private segment(): Note[] {
    if (!this.frames.size) return [];
    const h = this.hop;
    let k0 = Infinity;
    let k1 = -Infinity;
    for (const k of this.frames.keys()) {
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    // octave slips: a frame an octave away from its neighbourhood is folded back
    const raw: (number | null)[] = [];
    for (let k = k0 - 6; k <= k1 + 6; k++) raw.push(this.frames.get(k) ?? null);
    const fixed = raw.map((m, i) => {
      if (m === null) return null;
      const w = raw.slice(Math.max(0, i - 6), i + 7).filter((x): x is number => x !== null).sort((x, y) => x - y);
      const med = w[w.length >> 1];
      let v = m;
      while (v - med > 8) v -= 12;
      while (med - v > 8) v += 12;
      return v;
    });
    // smooth: median of 5 frames, kills single-frame jumps (consonants, breaths)
    const sm: (number | null)[] = [];
    for (let i = 6; i < fixed.length - 6; i++) {
      const w = fixed.slice(i - 2, i + 3).filter((x): x is number => x !== null);
      sm.push(w.length >= 3 ? w.sort((x, y) => x - y)[w.length >> 1] : null);
    }
    const out: Note[] = [];
    let cur: { s: number; e: number; ms: number[] } | null = null;
    const close = () => {
      if (cur && cur.e - cur.s >= 3) {
        const ms = [...cur.ms].sort((x, y) => x - y);
        const midi = Math.round(ms[ms.length >> 1]);
        const prev = out[out.length - 1];
        const start = (k0 + cur.s) * h;
        const end = (k0 + cur.e + 1) * h;
        // a short gap on (nearly) the same note is one sung note
        if (prev && Math.abs(prev.midi - midi) <= 1 && start - prev.end < 0.12) {
          if (end - start > prev.end - prev.start) prev.midi = midi;
          prev.end = end;
        } else out.push({ start, end, midi, text: '', kind: 'normal', line: 0 });
      }
      cur = null;
    };
    sm.forEach((m, i) => {
      if (m === null) return close();
      if (cur) {
        const ms = [...cur.ms].sort((x, y) => x - y);
        if (Math.abs(m - ms[ms.length >> 1]) > 0.75) close();
      }
      if (!cur) cur = { s: i, e: i, ms: [] };
      cur.e = i;
      cur.ms.push(m);
    });
    close();
    // too short to sing to: leave it out
    return out.filter((n) => n.end - n.start >= 0.14);
  }

  /**
   * Where the lyrics belong: the shift (media = line time + shift) that puts the most singing inside
   * the lyric lines and the least outside. Frames we have not heard yet count for nothing.
   */
  alignOffset(lines: { start: number; end: number }[], range: number | [number, number] = 40): { off: number; voiced: number; conf: number } | null {
    if (!lines.length || !this.frames.size) return null;
    const h = this.hop;
    let kMin = Infinity;
    let kMax = -Infinity;
    for (const k of this.frames.keys()) {
      if (k < kMin) kMin = k;
      if (k > kMax) kMax = k;
    }
    const n = kMax - kMin + 1;
    // +1 voiced, -0.5 heard but silent, 0 not heard; prefix sums for fast window totals
    const pre = new Float64Array(n + 1);
    let voiced = 0;
    for (let i = 0; i < n; i++) {
      const v = this.frames.get(kMin + i);
      const x = v === undefined ? 0 : v === null ? -0.5 : 1;
      if (x === 1) voiced++;
      pre[i + 1] = pre[i] + x;
    }
    const sum = (a: number, b: number) => {
      const i = Math.max(0, Math.min(n, a - kMin));
      const j = Math.max(0, Math.min(n, b - kMin));
      return j > i ? pre[j] - pre[i] : 0;
    };
    // where singing starts after a pause: lyric lines start there
    const onsets: number[] = [];
    let quiet = 0;
    for (let i = 0; i < n; i++) {
      const v = this.frames.get(kMin + i);
      if (v === null || v === undefined) quiet++;
      else {
        if (quiet * h >= 0.35) onsets.push((kMin + i) * h);
        quiet = 0;
      }
    }
    const near = (t: number) => {
      let lo2 = 0;
      let hi2 = onsets.length - 1;
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >> 1;
        if (onsets[mid] < t) lo2 = mid + 1;
        else hi2 = mid;
      }
      let d = Infinity;
      for (const j of [lo2 - 1, lo2]) if (j >= 0 && j < onsets.length) d = Math.min(d, Math.abs(onsets[j] - t));
      return d;
    };
    const heardFrom = kMin * h;
    const heardTo = (kMax + 1) * h;
    let best = -Infinity;
    let off = 0;
    const scores: [number, number][] = [];
    const [oLo, oHi] = typeof range === 'number' ? [-range, range] : range;
    for (let o = oLo; o <= oHi + 1e-9; o += 0.1) {
      let sc = 0;
      for (const l of lines) {
        sc += sum(Math.round((l.start + o) / h), Math.round((l.end + o) / h));
        // a line start on a singing onset is strong evidence (only where we have heard the song)
        const ts = l.start + o;
        if (ts > heardFrom && ts < heardTo && near(ts) < 0.3) sc += 25;
      }
      scores.push([o, sc]);
      if (sc > best + 1e-9) {
        best = sc;
        off = o;
      }
    }
    // how clearly the best beats any answer more than 2 s away (1 = no better than a guess)
    let second = 0;
    for (const [o, sc] of scores) if (Math.abs(o - off) > 2 && sc > second) second = sc;
    const conf = second > 0 ? best / second : best > 0 ? 9 : 0;
    return { off: Math.round(off * 10) / 10, voiced: voiced * h, conf };
  }

  /**
   * Character timings for a lyric line that only has a start time: the characters are spread over
   * the moments the separated vocal actually sings in [a, b] (media seconds). Null when too little
   * singing is known there yet.
   */
  charTimes(text: string, a: number, b: number): { start: number; end: number; text: string }[] | null {
    const h = this.hop;
    const ts: number[] = [];
    for (let k = Math.ceil(a / h); k <= Math.floor(b / h); k++) {
      // a frame counts if it or its neighbours are voiced (bridges consonants)
      const v = this.frames.get(k) ?? null;
      const n = (this.frames.get(k - 1) ?? null) !== null && (this.frames.get(k + 1) ?? null) !== null;
      if (v !== null || n) ts.push(k * h);
    }
    if (ts.length * h < 0.4) return null;
    // "singing" with no breath at all over a whole line is leaked music, not a voice: do not trust it
    if (ts.length * h > (b - a) * 0.92 && b - a > 3) return null;
    const chars = [...text];
    const units = chars.filter((c) => c.trim()).length || 1;
    const out: { start: number; end: number; text: string }[] = [];
    let u = 0;
    for (const c of chars) {
      if (!c.trim()) {
        out.push({ start: out.length ? out[out.length - 1].end : ts[0], end: out.length ? out[out.length - 1].end : ts[0], text: c });
        continue;
      }
      const i0 = Math.floor((u * ts.length) / units);
      const i1 = Math.max(i0, Math.floor(((u + 1) * ts.length) / units) - 1);
      out.push({ start: ts[i0], end: ts[i1] + h, text: c });
      u++;
    }
    return out;
  }
}
