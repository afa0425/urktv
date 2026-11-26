// Two rows on the same pitch scale: the original singer's bars on top, your own bars underneath,
// drawn live as you sing, so you can see at a glance whether they line up.
import type { Note } from '../core/chart';
import { midiName } from '../audio/pitch';
import { foldDiff } from '../core/score';
import type { TracePoint } from './lane';
import { countdownWord, goWord } from './cheers';

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
  /** Lyric characters with their sung times (chart time): written on the bars, like a KTV screen. */
  syl?: { start: number; end: number; text: string }[];
}


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

export function drawDualLane(ctx: CanvasRenderingContext2D, w: number, h: number, s: DualState, i: DualInput) {
  // one big lane (the original's notes, your voice riding on them) and a slim strip of your own
  // notes underneath, like the KTV apps people know
  const past = 2.2;
  const future = 5.2;
  const span = 12;
  const strip = Math.max(26, Math.round(h * 0.13));
  const laneH = h - strip - 6;
  const pad = 14;
  const pps = w / (past + future);
  const nowX = past * pps;
  const x = (t: number) => nowX + (t - i.now) * pps;
  const y = (m: number) => pad + (laneH - 2 * pad) / 2 - ((m - s.center) * (laneH - 2 * pad)) / span;
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
  if (lo <= hi) {
    const want = (lo + hi) / 2;
    // far away (song start, a jump): go there at once; otherwise glide
    s.center = Math.abs(want - s.center) > 6 ? want : s.center + (want - s.center) * 0.04;
  }

  const head = i.trace[i.trace.length - 1];
  const singing = head && head.midi !== null && i.now - head.t < 0.2 ? head : null;
  let target: Note | null = null;
  for (const n of i.notes) {
    if (n.start > i.now) break;
    if (n.end >= i.now) target = n;
  }

  ctx.clearRect(0, 0, w, h);
  // soft guides every other semitone, nothing louder
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let m = Math.floor(s.center - span / 2); m <= Math.ceil(s.center + span / 2); m += 2) {
    const yy = Math.round(y(m)) + 0.5;
    if (yy < 4 || yy > laneH - 4) continue;
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(w, yy);
    ctx.stroke();
  }
  // the "past" side is a little darker
  const pg = ctx.createLinearGradient(0, 0, nowX, 0);
  pg.addColorStop(0, 'rgba(0,0,0,0.35)');
  pg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = pg;
  ctx.fillRect(0, 0, nowX, laneH);

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

  // the original's notes: fat capsules
  const bh = Math.max(14, Math.min(26, ((laneH - 2 * pad) / span) * 1.35));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, laneH);
  ctx.clip();
  for (const n of i.notes) {
    if (n.end < i.now - past) continue;
    if (n.start > i.now + future) break;
    const x0 = x(n.start);
    const x1 = x(n.end);
    const bw = Math.max(bh, x1 - x0 - 3);
    const yy = y(n.midi + i.transpose) - bh / 2;
    const gold = n.kind === 'golden';
    const now = n.start <= i.now && n.end >= i.now;
    // every pitch has its own colour (low = warm, high = cool), so the melody reads at a glance
    const hue = (((n.midi + i.transpose) * 29) % 360 + 360) % 360;
    const high = (i.highlights ?? []).some((hl) => Math.abs(hl.start - n.start) < 0.05);
    const pulse = now ? 1 + 0.06 * Math.sin(t / 90) : 1;
    const ph = bh * pulse;
    const py = yy - (ph - bh) / 2;
    rr(ctx, x0, py, bw, ph, ph / 2);
    ctx.fillStyle = n.end < i.now ? 'rgba(255,255,255,0.05)' : `hsla(${hue},85%,62%,${now ? 0.55 : 0.26})`;
    if (now || high) {
      ctx.shadowColor = gold ? 'rgba(255,210,90,0.9)' : `hsla(${hue},95%,65%,0.95)`;
      ctx.shadowBlur = now ? 26 : 12;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
    // a glint running across the bars still to come
    if (n.start > i.now && bw > 18) {
      const g0 = ((t / 1000) * 0.5 + n.start * 0.37) % 1;
      const gx = x0 + g0 * (bw + 40) - 20;
      ctx.save();
      rr(ctx, x0, py, bw, ph, ph / 2);
      ctx.clip();
      const gl = ctx.createLinearGradient(gx - 16, 0, gx + 16, 0);
      gl.addColorStop(0, 'rgba(255,255,255,0)');
      gl.addColorStop(0.5, 'rgba(255,255,255,0.35)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl;
      ctx.fillRect(gx - 16, py, 32, ph);
      ctx.restore();
    }
    // what you have sung of it fills with colour: its own colour into gold when you were on it
    if (n.start < i.now) {
      const px = Math.min(x1, nowX) - x0;
      if (px > 0) {
        const r = hitIn(n);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, py - 4, px, ph + 8);
        ctx.clip();
        rr(ctx, x0, py, bw, ph, ph / 2);
        if (r >= 0.5) {
          const g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
          g.addColorStop(0, gold ? '#ffcf3f' : `hsl(${hue},95%,62%)`);
          g.addColorStop(1, gold ? '#fff1a8' : '#ffd36b');
          ctx.fillStyle = g;
          ctx.shadowColor = gold ? '#ffd54a' : `hsl(${hue},95%,60%)`;
          ctx.shadowBlur = 16;
        } else ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
      }
    }
    // outline
    rr(ctx, x0, py, bw, ph, ph / 2);
    ctx.strokeStyle = gold ? 'rgba(255,214,110,0.95)' : now ? '#fff' : n.end < i.now ? 'rgba(255,255,255,0.15)' : `hsla(${hue},95%,78%,0.8)`;
    ctx.lineWidth = gold || now ? 2 : 1.2;
    ctx.stroke();
    // what to sing on this bar: its lyric character(s); else a mark for special notes
    ctx.textBaseline = 'middle';
    const chars = (i.syl ?? []).filter((c) => c.text.trim() && c.start >= n.start - 0.08 && c.start < n.end).map((c) => c.text).join('');
    let mark = chars;
    if (!mark && high && n.end >= i.now) mark = '🔥';
    else if (!mark && n.end - n.start >= 1.2 && n.end >= i.now) mark = '長音';
    if (mark && bw > 16) {
      ctx.font = `bold ${Math.round(Math.min(16, bh * 0.72))}px system-ui, sans-serif`;
      ctx.fillStyle = n.end < i.now ? 'rgba(255,255,255,0.35)' : '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      const tx = x0 + (gold ? bh + 2 : 8);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, py, bw, ph);
      ctx.clip();
      ctx.fillText(mark, tx, py + ph / 2 + 1);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
    if (high && chars && n.end >= i.now) {
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('🔥', x0 - 6, py - 6);
    }
    if (gold && n.end >= i.now) {
      ctx.font = `${Math.round(bh * 0.7)}px system-ui, sans-serif`;
      ctx.fillText('⭐', x0 + 4, yy + bh / 2 + 1);
    }
  }
  // the original's real pitch curve (prepared songs)
  if (i.curve) {
    const { hop, midi } = i.curve;
    const a = Math.max(0, Math.floor((i.now - past) / hop));
    const b = Math.min(midi.length, Math.ceil((i.now + future) / hop));
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
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
      const py = y(m + i.transpose);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  }
  // your voice: a comet trail on the lane, brighter towards now
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let prev: TracePoint | null = null;
  for (const p of i.trace) {
    if (p.t < i.now - 1.6) continue;
    if (p.midi === null || !prev || prev.midi === null || p.t - prev.t > 0.12) {
      prev = p;
      continue;
    }
    const age = Math.max(0, Math.min(1, 1 - (i.now - p.t) / 1.6));
    ctx.strokeStyle = p.hit ? `rgba(120,255,200,${0.25 + age * 0.7})` : `rgba(255,180,120,${0.2 + age * 0.6})`;
    ctx.lineWidth = 2 + age * 4;
    ctx.beginPath();
    ctx.moveTo(x(prev.t), y(prev.midi));
    ctx.lineTo(x(p.t), y(p.midi));
    ctx.stroke();
    prev = p;
  }
  ctx.restore();

  // now line
  const ng = ctx.createLinearGradient(0, 0, 0, laneH);
  ng.addColorStop(0, 'rgba(255,92,138,0)');
  ng.addColorStop(0.5, 'rgba(255,92,138,0.95)');
  ng.addColorStop(1, 'rgba(255,179,71,0)');
  ctx.strokeStyle = ng;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(Math.round(nowX) + 0.5, 0);
  ctx.lineTo(Math.round(nowX) + 0.5, laneH);
  ctx.stroke();

  // target note name on the left edge, your note next to your ball
  ctx.textBaseline = 'middle';
  if (target) {
    const yy = y(target.midi + i.transpose);
    const label = midiName(target.midi + i.transpose);
    ctx.font = 'bold 12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 14;
    rr(ctx, 6, yy - 10, tw, 20, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(label, 13, yy + 0.5);
  }
  if (singing && singing.midi !== null) {
    const yy = y(singing.midi);
    if (yy >= 0 && yy <= laneH) {
      const col = singing.hit ? '#78ffc8' : '#ffb478';
      const glow = ctx.createRadialGradient(nowX, yy, 0, nowX, yy, 22);
      glow.addColorStop(0, singing.hit ? 'rgba(120,255,200,0.55)' : 'rgba(255,180,120,0.45)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(nowX, yy, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(nowX, yy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.font = 'bold 12px system-ui, sans-serif';
      const label = midiName(Math.round(singing.midi));
      const tw = ctx.measureText(label).width + 12;
      rr(ctx, nowX + 14, yy - 10, tw, 20, 10);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fillText(label, nowX + 20, yy + 0.5);
      if (singing.hit && Math.random() < 0.7) {
        for (let k = 0; k < 2; k++)
          sparks.push({ x: nowX, y: yy, vx: -50 - Math.random() * 110, vy: (Math.random() - 0.5) * 140, life: 0.5 + Math.random() * 0.5, hue: target?.kind === 'golden' ? 45 : 330 + Math.random() * 60 });
      }
    }
  }

  // high-note countdown: a pill over the lane
  for (const hl of i.highlights ?? []) {
    const dt2 = hl.start - i.now;
    if (dt2 > 3.2 || hl.end < i.now) continue;
    const k = Math.round(hl.start * 10);
    const label = dt2 > 0 ? `${countdownWord(k)} ${Math.ceil(dt2)}` : `${hl.peak} ${goWord(k)}`;
    ctx.font = 'bold 16px system-ui, sans-serif';
    const tw = ctx.measureText(label).width + 28;
    const hx = Math.max(10, Math.min(w - tw - 10, x(hl.start) - tw / 2));
    rr(ctx, hx, 8, tw, 30, 15);
    const g = ctx.createLinearGradient(hx, 0, hx + tw, 0);
    g.addColorStop(0, 'rgba(255,92,138,0.9)');
    g.addColorStop(1, 'rgba(255,179,71,0.9)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = '#1a0f16';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, hx + 14, 24);
  }

  // sparks
  for (let k = sparks.length - 1; k >= 0; k--) {
    const p = sparks[k];
    p.life -= dt;
    if (p.life <= 0) {
      sparks.splice(k, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 80 * dt;
    ctx.fillStyle = `hsla(${p.hue},95%,68%,${Math.min(1, p.life * 1.6)})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (sparks.length > 300) sparks.splice(0, sparks.length - 300);

  // the strip of your own notes: what you sang, coloured by how it went
  const sy = h - strip;
  rr(ctx, 0, sy, w, strip, 10);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fill();
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText('你', 8, sy + strip / 2);
  const ys = (m: number) => sy + strip / 2 - ((m - s.center) * (strip - 8)) / (span * 1.6);
  for (const b of userBars(i.trace)) {
    if (b.end < i.now - past) continue;
    const x0 = Math.max(22, x(b.start));
    const x1 = x(b.end);
    if (x1 <= x0) continue;
    const yy = Math.max(sy + 3, Math.min(sy + strip - 9, ys(b.midi) - 3));
    rr(ctx, x0, yy, Math.max(3, x1 - x0), 6, 3);
    ctx.fillStyle = b.state === 'star' ? '#ffd24c' : b.state === 'hit' ? '#78ffc8' : '#ff9a6a';
    ctx.fill();
  }
}

/** Which way a missed note was off, for a gentle hint (+ = sang too high). */
export function meanOffset(trace: TracePoint[], n: Note, transpose: number): number | null {
  const d: number[] = [];
  for (const p of trace) if (p.midi !== null && p.t >= n.start && p.t < n.end) d.push(foldDiff(p.midi, n.midi + transpose));
  if (d.length < 5) return null;
  return d.reduce((a, b) => a + b, 0) / d.length;
}
