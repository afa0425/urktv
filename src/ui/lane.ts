import { drawBackdrop } from './dualLane';
import type { Note } from '../core/chart';
import { midiName } from '../audio/pitch';

export interface TracePoint {
  t: number;
  midi: number | null;
  hit: boolean;
}

export interface LaneState {
  /** Smoothed vertical centre (MIDI); kept between frames. */
  center: number;
}

export interface LaneInput {
  /** How loud the singer is (0-1): the backdrop breathes with it. */
  level?: number;
  now: number;
  trace: TracePoint[];
  /** Target melody, or null in free mode. */
  notes: Note[] | null;
  transpose: number;
  live: number | null;
}

const C = {
  grid: 'rgba(255,255,255,0.06)',
  gridC: 'rgba(255,255,255,0.14)',
  label: 'rgba(255,255,255,0.38)',
  note: 'rgba(170,160,255,0.30)',
  noteEdge: 'rgba(190,182,255,0.75)',
  gold: 'rgba(255,196,86,0.38)',
  goldEdge: 'rgba(255,208,120,0.95)',
  past: 'rgba(255,255,255,0.10)',
  hit: '#5df2b6',
  miss: '#ff6b9d',
  now: 'rgba(255,255,255,0.55)',
};

/** The note sounding at t, or else the one closest in time. */
export function nearestNote(notes: Note[], t: number): Note | null {
  if (!notes.length) return null;
  let lo = 0;
  let hi = notes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  const a = notes[lo];
  const b = notes[lo - 1];
  if (!b || a.start <= t) return a;
  return t - b.end <= a.start - t ? b : a;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draws the scrolling pitch lane. w/h are CSS pixels; the context is already scaled for the device. */
export function drawLane(ctx: CanvasRenderingContext2D, w: number, h: number, s: LaneState, i: LaneInput) {
  const guide = !!i.notes;
  const past = guide ? 2.5 : 6;
  const future = guide ? 5.5 : 1;
  const span = guide ? 18 : 24;
  const pps = w / (past + future);
  const nowX = past * pps;
  const semi = h / span;
  const x = (t: number) => nowX + (t - i.now) * pps;
  const y = (m: number) => h / 2 - (m - s.center) * semi;

  // Follow the melody (or, in free mode, the singer) vertically.
  let want = s.center;
  if (guide) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of i.notes!) {
      if (n.end < i.now - 1) continue;
      if (n.start > i.now + future) break;
      const m = n.midi + i.transpose;
      lo = Math.min(lo, m);
      hi = Math.max(hi, m);
    }
    if (lo <= hi) want = (lo + hi) / 2;
  } else if (i.live !== null) {
    if (Math.abs(i.live - s.center) > span / 2 - 4) want = i.live;
  }
  s.center += (want - s.center) * 0.06;

  ctx.clearRect(0, 0, w, h);
  drawBackdrop(ctx, w, h, i.level);

  // pitch grid, one line per semitone, C's labelled
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const top = Math.ceil(s.center + span / 2);
  for (let m = Math.floor(s.center - span / 2); m <= top; m++) {
    const yy = Math.round(y(m)) + 0.5;
    const isC = ((m % 12) + 12) % 12 === 0;
    ctx.strokeStyle = isC ? C.gridC : C.grid;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w, yy);
    ctx.stroke();
    if (isC) {
      ctx.fillStyle = C.label;
      ctx.fillText(midiName(m), 6, yy - 8);
    }
  }

  if (guide) {
    const bar = Math.max(8, semi * 0.9);
    for (const n of i.notes!) {
      if (n.end < i.now - past) continue;
      if (n.start > i.now + future) break;
      if (n.kind === 'free') continue;
      const x0 = x(n.start);
      const x1 = x(n.end);
      const yy = y(n.midi + i.transpose) - bar / 2;
      const gold = n.kind === 'golden';
      roundRect(ctx, x0, yy, Math.max(3, x1 - x0), bar, 5);
      ctx.fillStyle = n.end < i.now ? C.past : gold ? C.gold : C.note;
      ctx.fill();
      if (n.end >= i.now) {
        ctx.strokeStyle = gold ? C.goldEdge : C.noteEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // the singer's pitch
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let prev: TracePoint | null = null;
  for (const p of i.trace) {
    if (p.midi === null || p.t < i.now - past - 0.2) {
      prev = null;
      continue;
    }
    if (prev && p.t - prev.t < 0.15 && Math.abs(p.midi - prev.midi!) < 5) {
      ctx.strokeStyle = p.hit ? C.hit : C.miss;
      ctx.beginPath();
      ctx.moveTo(x(prev.t), y(prev.midi!));
      ctx.lineTo(x(p.t), y(p.midi));
      ctx.stroke();
    }
    prev = p;
  }

  ctx.strokeStyle = C.now;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(nowX) + 0.5, 0);
  ctx.lineTo(Math.round(nowX) + 0.5, h);
  ctx.stroke();

  const head = i.trace[i.trace.length - 1];
  if (head && head.midi !== null && i.now - head.t < 0.2) {
    ctx.fillStyle = head.hit ? C.hit : C.miss;
    ctx.beginPath();
    ctx.arc(nowX, y(head.midi), 6, 0, Math.PI * 2);
    ctx.fill();
  }
}
