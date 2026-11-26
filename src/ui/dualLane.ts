// Two rows on the same pitch scale: the original singer's bars on top, your own bars underneath,
// drawn live as you sing, so you can see at a glance whether they line up.
import type { Note } from '../core/chart';
import { midiName } from '../audio/pitch';
import { foldDiff } from '../core/score';
import type { TracePoint } from './lane';

export interface DualState {
  center: number;
}

export interface DualInput {
  now: number;
  trace: TracePoint[];
  notes: Note[];
  transpose: number;
  /** The original singer's pitch curve (catalog songs), drawn faintly over the top bars. */
  curve?: { hop: number; midi: (number | null)[] };
  /** Highest-note moments: a countdown appears before each. */
  highlights?: { start: number; end: number; peak: string }[];
}

const C = {
  bgTop: 'rgba(255,255,255,0.025)',
  grid: 'rgba(255,255,255,0.05)',
  gridC: 'rgba(255,255,255,0.13)',
  label: 'rgba(255,255,255,0.42)',
  note: 'rgba(170,160,255,0.34)',
  noteEdge: 'rgba(196,188,255,0.85)',
  gold: 'rgba(255,196,86,0.42)',
  goldEdge: 'rgba(255,212,128,1)',
  past: 'rgba(255,255,255,0.10)',
  curve: 'rgba(255,255,255,0.45)',
  hit: '#5df2b6',
  off: '#ffa24c',
  star: '#ffd24c',
  now: 'rgba(255,255,255,0.6)',
  flame: '#ff5c8a',
};

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + q, y);
  ctx.arcTo(x + w, y, x + w, y + h, q);
  ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q);
  ctx.arcTo(x, y, x + w, y, q);
  ctx.closePath();
}

export interface UserBar {
  start: number;
  end: number;
  midi: number;
  state: 'hit' | 'off' | 'star';
}

/** Groups the live pitch trace into bars, the same way the original's notes look. */
export function userBars(trace: TracePoint[]): UserBar[] {
  const bars: UserBar[] = [];
  let cur: { start: number; end: number; ms: number[]; hits: number } | null = null;
  const close = () => {
    if (!cur || cur.end - cur.start < 0.06) return;
    const s = [...cur.ms].sort((a, b) => a - b);
    const midi = s[s.length >> 1];
    const hitShare = cur.hits / cur.ms.length;
    const state = hitShare >= 0.5 ? (cur.end - cur.start >= 0.8 ? 'star' : 'hit') : 'off';
    bars.push({ start: cur.start, end: cur.end, midi, state });
  };
  let prevT = -1;
  for (const p of trace) {
    if (p.midi === null) {
      close();
      cur = null;
      continue;
    }
    if (cur && (p.t - prevT > 0.12 || Math.abs(p.midi - cur.ms[cur.ms.length - 1]) > 0.6)) {
      close();
      cur = null;
    }
    if (!cur) cur = { start: p.t, end: p.t, ms: [], hits: 0 };
    cur.end = p.t;
    cur.ms.push(p.midi);
    if (p.hit) cur.hits++;
    prevT = p.t;
  }
  close();
  return bars;
}

export function drawDualLane(ctx: CanvasRenderingContext2D, w: number, h: number, s: DualState, i: DualInput) {
  const past = 2.5;
  const future = 5.5;
  const span = 16;
  const pps = w / (past + future);
  const nowX = past * pps;
  const gap = 6;
  const topH = Math.round(h * 0.54);
  const botY = topH + gap;
  const botH = h - botY;
  const x = (t: number) => nowX + (t - i.now) * pps;
  const yIn = (m: number, y0: number, hh: number) => y0 + hh / 2 - ((m - s.center) * hh) / span;

  // follow the melody vertically
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of i.notes) {
    if (n.end < i.now - 1) continue;
    if (n.start > i.now + future) break;
    lo = Math.min(lo, n.midi + i.transpose);
    hi = Math.max(hi, n.midi + i.transpose);
  }
  if (lo <= hi) s.center += ((lo + hi) / 2 - s.center) * 0.05;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.bgTop;
  ctx.fillRect(0, 0, w, topH);

  // grid in both rows
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const [y0, hh] of [
    [0, topH],
    [botY, botH],
  ] as const) {
    for (let m = Math.floor(s.center - span / 2); m <= Math.ceil(s.center + span / 2); m++) {
      const yy = Math.round(yIn(m, y0, hh)) + 0.5;
      if (yy < y0 || yy > y0 + hh) continue;
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.strokeStyle = isC ? C.gridC : C.grid;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
      if (isC) {
        ctx.fillStyle = C.label;
        ctx.fillText(midiName(m), w - 30, yy - 7);
      }
    }
  }
  ctx.fillStyle = C.label;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillText('原唱', 8, 12);
  ctx.fillText('你', 8, botY + 12);

  // top row: the original's bars
  const barTop = Math.max(8, (topH / span) * 0.85);
  for (const n of i.notes) {
    if (n.end < i.now - past) continue;
    if (n.start > i.now + future) break;
    const x0 = x(n.start);
    const x1 = x(n.end);
    const yy = yIn(n.midi + i.transpose, 0, topH) - barTop / 2;
    if (yy < 0 || yy + barTop > topH) continue; // outside its row
    const gold = n.kind === 'golden';
    rr(ctx, x0, yy, Math.max(3, x1 - x0 - 1), barTop, 5);
    ctx.fillStyle = n.end < i.now ? C.past : gold ? C.gold : C.note;
    ctx.fill();
    if (n.end >= i.now) {
      ctx.strokeStyle = gold ? C.goldEdge : C.noteEdge;
      ctx.lineWidth = gold ? 1.5 : 1;
      ctx.stroke();
    }
  }
  // the original's real pitch curve: slides, vibrato and runs show here
  if (i.curve) {
    const { hop, midi } = i.curve;
    const a = Math.max(0, Math.floor((i.now - past) / hop));
    const b = Math.min(midi.length, Math.ceil((i.now + future) / hop));
    ctx.strokeStyle = C.curve;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let pen = false;
    for (let k = a; k < b; k++) {
      const m = midi[k];
      if (m === null) {
        pen = false;
        continue;
      }
      const px = x(k * hop);
      const py = yIn(m + i.transpose, 0, topH);
      if (py < 0 || py > topH) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }

  // high-note countdown
  for (const hl of i.highlights ?? []) {
    const dt = hl.start - i.now;
    if (dt > 3.2 || hl.end < i.now) continue;
    const hx = Math.max(60, Math.min(w - 60, x(hl.start)));
    ctx.textAlign = 'center';
    ctx.fillStyle = C.flame;
    ctx.font = 'bold 15px system-ui, sans-serif';
    const label = dt > 0 ? `🔥 高音來了 ${Math.ceil(dt)}` : `🔥 ${hl.peak} 衝！`;
    ctx.fillText(label, hx, 14);
    ctx.textAlign = 'left';
  }

  // bottom row: your bars
  const bars = userBars(i.trace);
  const barBot = Math.max(8, (botH / span) * 0.85);
  for (const b of bars) {
    if (b.end < i.now - past) continue;
    const x0 = x(b.start);
    const x1 = x(b.end);
    const yy = yIn(b.midi, botY, botH) - barBot / 2;
    if (yy < botY || yy + barBot > h) continue;
    rr(ctx, x0, yy, Math.max(3, x1 - x0), barBot, 5);
    ctx.fillStyle = b.state === 'star' ? C.star : b.state === 'hit' ? C.hit : C.off;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // a faint copy of the original's bars in your row, so you can aim
  ctx.strokeStyle = 'rgba(196,188,255,0.25)';
  ctx.setLineDash([4, 4]);
  for (const n of i.notes) {
    if (n.end < i.now - past) continue;
    if (n.start > i.now + future) break;
    const yy = yIn(n.midi + i.transpose, botY, botH) - barBot / 2;
    if (yy < botY || yy + barBot > h) continue;
    rr(ctx, x(n.start), yy, Math.max(3, x(n.end) - x(n.start) - 1), barBot, 5);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // now line through both rows
  ctx.strokeStyle = C.now;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(Math.round(nowX) + 0.5, 0);
  ctx.lineTo(Math.round(nowX) + 0.5, h);
  ctx.stroke();

  // live dot in your row
  const head = i.trace[i.trace.length - 1];
  if (head && head.midi !== null && i.now - head.t < 0.2) {
    const yy = yIn(head.midi, botY, botH);
    if (yy >= botY && yy <= botY + botH) {
      ctx.fillStyle = head.hit ? C.hit : C.off;
      ctx.beginPath();
      ctx.arc(nowX, yy, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Which way a missed note was off, for a gentle hint (+ = sang too high). */
export function meanOffset(trace: TracePoint[], n: Note, transpose: number): number | null {
  const d: number[] = [];
  for (const p of trace) if (p.midi !== null && p.t >= n.start && p.t < n.end) d.push(foldDiff(p.midi, n.midi + transpose));
  if (d.length < 5) return null;
  return d.reduce((a, b) => a + b, 0) / d.length;
}
