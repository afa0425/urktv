// Gray bars for songs nobody prepared: the extension sends the pitch of the separated vocal a few
// seconds ahead of the picture; this turns it into bars the same way a prepared song looks.
import type { Note } from './chart';

export class LiveNotes {
  private frames = new Map<number, number | null>();
  hop = 512 / 22050;
  /** Last media time with pitch data (bars exist up to here). */
  edge = 0;

  add(t: number, hop: number, midi: (number | null)[]) {
    this.hop = hop;
    const k0 = Math.round(t / hop);
    midi.forEach((m, i) => this.frames.set(k0 + i, m));
    this.edge = Math.max(this.edge, t + midi.length * hop);
    if (this.frames.size > 200000) this.frames.clear(); // a very long session: start over
  }

  has() {
    return this.frames.size > 0;
  }

  /** Bars between a and b (media seconds). */
  between(a: number, b: number): Note[] {
    const h = this.hop;
    const k0 = Math.floor(a / h);
    const k1 = Math.ceil(b / h);
    // smooth: median of 5 frames, kills single-frame jumps (octave slips, consonants)
    const raw: (number | null)[] = [];
    for (let k = k0 - 2; k <= k1 + 2; k++) raw.push(this.frames.get(k) ?? null);
    const sm: (number | null)[] = [];
    for (let i = 2; i < raw.length - 2; i++) {
      const w = raw.slice(i - 2, i + 3).filter((x): x is number => x !== null);
      sm.push(w.length >= 3 ? w.sort((x, y) => x - y)[w.length >> 1] : null);
    }
    const out: Note[] = [];
    let cur: { s: number; e: number; ms: number[] } | null = null;
    const close = () => {
      if (cur && cur.e - cur.s >= 4) {
        const ms = [...cur.ms].sort((x, y) => x - y);
        const midi = Math.round(ms[ms.length >> 1]);
        const prev = out[out.length - 1];
        const start = (k0 + cur.s) * h;
        if (prev && prev.midi === midi && start - prev.end < 0.08) prev.end = (k0 + cur.e + 1) * h;
        else out.push({ start, end: (k0 + cur.e + 1) * h, midi, text: '', kind: 'normal', line: 0 });
      }
      cur = null;
    };
    sm.forEach((m, i) => {
      if (m === null) return close();
      if (cur) {
        const ms = [...cur.ms].sort((x, y) => x - y);
        if (Math.abs(m - ms[ms.length >> 1]) > 0.7) close();
      }
      if (!cur) cur = { s: i, e: i, ms: [] };
      cur.e = i;
      cur.ms.push(m);
    });
    close();
    return out;
  }

  /**
   * Where the lyrics belong: the shift (media = line time + shift) that puts the most singing inside
   * the lyric lines and the least outside. Frames we have not heard yet count for nothing.
   */
  alignOffset(lines: { start: number; end: number }[], range = 40): { off: number; voiced: number } | null {
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
    let best = -Infinity;
    let off = 0;
    for (let o = -range; o <= range; o += 0.1) {
      let sc = 0;
      for (const l of lines) sc += sum(Math.round((l.start + o) / h), Math.round((l.end + o) / h));
      if (sc > best + 1e-9) {
        best = sc;
        off = o;
      }
    }
    return { off: Math.round(off * 10) / 10, voiced: voiced * h };
  }
}
