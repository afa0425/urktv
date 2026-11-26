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

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  hue: number;
}
const sparks: Spark[] = [];
let lastFrame = 0;
const NAT = new Set([0, 2, 4, 5, 7, 9, 11]);

export function drawDualLane(ctx: CanvasRenderingContext2D, w: number, h: number, s: DualState, i: DualInput) {
  const past = 2.5;
  const future = 5.5;
  const span = 16;
  const ladder = 46; // note-name column on the left
  const pps = (w - ladder) / (past + future);
  const nowX = ladder + past * pps;
  const gap = 8;
  const topH = Math.round(h * 0.56);
  const botY = topH + gap;
  const botH = h - botY;
  const x = (t: number) => nowX + (t - i.now) * pps;
  const yIn = (m: number, y0: number, hh: number) => y0 + hh / 2 - ((m - s.center) * hh) / span;
  const t = performance.now();
  const dt = Math.min(0.05, (t - (lastFrame || t)) / 1000);
  lastFrame = t;

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

  const head = i.trace[i.trace.length - 1];
  const singing = head && head.midi !== null && i.now - head.t < 0.2 ? head : null;
  // the note being sung now in the original
  let target: Note | null = null;
  for (const n of i.notes) {
    if (n.start > i.now) break;
    if (n.end >= i.now) target = n;
  }

  ctx.clearRect(0, 0, w, h);
  // rows
  const rowBg = (y0: number, hh: number, a: number) => {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + hh);
    g.addColorStop(0, `rgba(140,110,255,${a})`);
    g.addColorStop(1, 'rgba(140,110,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ladder, y0, w - ladder, hh);
  };
  rowBg(0, topH, 0.06);
  rowBg(botY, botH, 0.03);

  // semitone grid + note ladder (dynamic: the sung note and the target note light up)
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  const lit = new Map<number, string>();
  if (target) lit.set(target.midi + i.transpose, 'rgba(196,188,255,0.9)');
  if (singing && singing.midi !== null) lit.set(Math.round(singing.midi), singing.hit ? C.hit : C.off);
  for (const [y0, hh] of [
    [0, topH],
    [botY, botH],
  ] as const) {
    for (let m = Math.floor(s.center - span / 2); m <= Math.ceil(s.center + span / 2); m++) {
      const yy = Math.round(yIn(m, y0, hh)) + 0.5;
      if (yy < y0 + 4 || yy > y0 + hh - 4) continue;
      const pc = ((m % 12) + 12) % 12;
      ctx.strokeStyle = pc === 0 ? C.gridC : C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ladder, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
      if (y0 === 0 || botH > 90) {
        const col = lit.get(m);
        if (col) {
          ctx.fillStyle = col;
          rr(ctx, 4, yy - 8, ladder - 8, 16, 8);
          ctx.globalAlpha = 0.25;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.font = 'bold 11px system-ui, sans-serif';
          ctx.fillStyle = col;
          ctx.fillText(midiName(m), ladder - 8, yy);
        } else if (NAT.has(pc) && (hh / span >= 13 || pc === 0 || pc === 4 || pc === 7 || pc === 9)) {
          ctx.font = (pc === 0 ? 'bold ' : '') + '10px system-ui, sans-serif';
          ctx.fillStyle = pc === 0 ? C.label : 'rgba(255,255,255,0.22)';
          ctx.fillText(midiName(m), ladder - 8, yy);
        }
      }
    }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = C.label;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillText('原唱', ladder + 8, 12);
  ctx.fillText('你', ladder + 8, botY + 12);

  // which original notes you hit (for lighting them up)
  const hitIn = (n: Note) => {
    let a = 0;
    let b = 0;
    for (let k = i.trace.length - 1; k >= 0; k--) {
      const p = i.trace[k];
      if (p.t < n.start) break;
      if (p.t > n.end) continue;
      b++;
      if (p.hit) a++;
    }
    return b ? a / b : 0;
  };

  // top row: the original's bars
  const barTop = Math.max(14, (topH / span) * 1.1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ladder, 0, w - ladder, topH);
  ctx.clip();
  for (const n of i.notes) {
    if (n.end < i.now - past) continue;
    if (n.start > i.now + future) break;
    const x0 = x(n.start);
    const x1 = x(n.end);
    const bw = Math.max(4, x1 - x0 - 2);
    const yy = yIn(n.midi + i.transpose, 0, topH) - barTop / 2;
    if (yy < 0 || yy + barTop > topH) continue;
    const gold = n.kind === 'golden';
    const now = n.start <= i.now && n.end >= i.now;
    // body
    const g = ctx.createLinearGradient(x0, yy, x0, yy + barTop);
    if (gold) {
      g.addColorStop(0, 'rgba(255,214,120,0.75)');
      g.addColorStop(1, 'rgba(255,160,60,0.55)');
    } else {
      g.addColorStop(0, 'rgba(185,170,255,0.55)');
      g.addColorStop(1, 'rgba(120,100,240,0.4)');
    }
    rr(ctx, x0, yy, bw, barTop, barTop / 2);
    ctx.fillStyle = n.end < i.now ? C.past : g;
    if (now) {
      ctx.shadowColor = gold ? C.goldEdge : 'rgba(190,175,255,0.9)';
      ctx.shadowBlur = 16;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    // the part already sung lights up: green if you were on it, faint otherwise
    if (n.start < i.now) {
      const r = hitIn(n);
      const px = Math.min(x1, nowX) - x0;
      if (px > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, yy - 2, px, barTop + 4);
        ctx.clip();
        rr(ctx, x0, yy, bw, barTop, barTop / 2);
        ctx.fillStyle = r >= 0.5 ? (gold ? 'rgba(255,210,76,0.95)' : 'rgba(93,242,182,0.85)') : 'rgba(255,255,255,0.16)';
        ctx.fill();
        ctx.restore();
      }
    }
    if (n.end >= i.now) {
      ctx.strokeStyle = gold ? C.goldEdge : C.noteEdge;
      ctx.lineWidth = now ? 2 : 1;
      rr(ctx, x0, yy, bw, barTop, barTop / 2);
      ctx.stroke();
    }
    // note name on bars that are wide enough
    if (bw > 30 && n.start > i.now - 0.2) {
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(midiName(n.midi + i.transpose), x0 + 7, yy + barTop / 2 + 0.5);
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
  // your voice on the original's row too: a glowing trail, so you see it against the bars
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let prev: TracePoint | null = null;
  for (const p of i.trace) {
    if (p.t < i.now - past) continue;
    if (p.midi === null || !prev || prev.midi === null || p.t - prev.t > 0.12) {
      prev = p;
      continue;
    }
    ctx.strokeStyle = p.hit ? 'rgba(93,242,182,0.85)' : 'rgba(255,162,76,0.7)';
    ctx.beginPath();
    ctx.moveTo(x(prev.t), yIn(prev.midi, 0, topH));
    ctx.lineTo(x(p.t), yIn(p.midi, 0, topH));
    ctx.stroke();
    prev = p;
  }
  ctx.restore();

  // high-note countdown
  for (const hl of i.highlights ?? []) {
    const dt2 = hl.start - i.now;
    if (dt2 > 3.2 || hl.end < i.now) continue;
    const hx = Math.max(90, Math.min(w - 60, x(hl.start)));
    ctx.textAlign = 'center';
    ctx.fillStyle = C.flame;
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(dt2 > 0 ? `🔥 高音來了 ${Math.ceil(dt2)}` : `🔥 ${hl.peak} 衝！`, hx, 14);
    ctx.textAlign = 'left';
  }

  // bottom row: your bars
  ctx.save();
  ctx.beginPath();
  ctx.rect(ladder, botY, w - ladder, botH);
  ctx.clip();
  const bars = userBars(i.trace);
  const barBot = Math.max(8, (botH / span) * 0.85);
  for (const b of bars) {
    if (b.end < i.now - past) continue;
    const x0 = x(b.start);
    const x1 = x(b.end);
    const yy = yIn(b.midi, botY, botH) - barBot / 2;
    if (yy < botY || yy + barBot > h) continue;
    rr(ctx, x0, yy, Math.max(3, x1 - x0), barBot, barBot / 2);
    ctx.fillStyle = b.state === 'star' ? C.star : b.state === 'hit' ? C.hit : C.off;
    ctx.shadowColor = ctx.fillStyle as string;
    ctx.shadowBlur = b.state === 'off' ? 0 : 10;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }
  // a faint copy of the original's bars in your row, so you can aim
  ctx.strokeStyle = 'rgba(196,188,255,0.25)';
  ctx.setLineDash([4, 4]);
  for (const n of i.notes) {
    if (n.end < i.now - past) continue;
    if (n.start > i.now + future) break;
    const yy = yIn(n.midi + i.transpose, botY, botH) - barBot / 2;
    if (yy < botY || yy + barBot > h) continue;
    rr(ctx, x(n.start), yy, Math.max(3, x(n.end) - x(n.start) - 1), barBot, barBot / 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // now line through both rows
  const ng = ctx.createLinearGradient(0, 0, 0, h);
  ng.addColorStop(0, 'rgba(255,92,138,0.9)');
  ng.addColorStop(1, 'rgba(255,179,71,0.9)');
  ctx.strokeStyle = ng;
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(255,92,138,0.8)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(Math.round(nowX) + 0.5, 0);
  ctx.lineTo(Math.round(nowX) + 0.5, h);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // your voice: a glowing ball with its note name, in the original's row (where you aim)
  if (singing && singing.midi !== null) {
    const yy = yIn(singing.midi, 0, topH);
    if (yy >= 0 && yy <= topH) {
      const col = singing.hit ? C.hit : C.off;
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(nowX, yy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = 'bold 11px system-ui, sans-serif';
      const label = midiName(Math.round(singing.midi));
      const tw = ctx.measureText(label).width + 10;
      rr(ctx, nowX + 12, yy - 9, tw, 18, 9);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fillText(label, nowX + 17, yy + 0.5);
      // sparkles while you are on the note
      if (singing.hit && Math.random() < 0.6) {
        for (let k = 0; k < 2; k++)
          sparks.push({ x: nowX, y: yy, vx: -40 - Math.random() * 90, vy: (Math.random() - 0.5) * 120, life: 0.6 + Math.random() * 0.4, hue: target?.kind === 'golden' ? 45 : 150 + Math.random() * 30 });
      }
    }
    const by = yIn(singing.midi, botY, botH);
    if (by >= botY && by <= botY + botH) {
      ctx.fillStyle = singing.hit ? C.hit : C.off;
      ctx.beginPath();
      ctx.arc(nowX, by, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let k = sparks.length - 1; k >= 0; k--) {
    const p = sparks[k];
    p.life -= dt;
    if (p.life <= 0) {
      sparks.splice(k, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 60 * dt;
    ctx.fillStyle = `hsla(${p.hue},95%,65%,${Math.min(1, p.life * 1.5)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (sparks.length > 300) sparks.splice(0, sparks.length - 300);
}

/** Which way a missed note was off, for a gentle hint (+ = sang too high). */
export function meanOffset(trace: TracePoint[], n: Note, transpose: number): number | null {
  const d: number[] = [];
  for (const p of trace) if (p.midi !== null && p.t >= n.start && p.t < n.end) d.push(foldDiff(p.midi, n.midi + transpose));
  if (d.length < 5) return null;
  return d.reduce((a, b) => a + b, 0) / d.length;
}
