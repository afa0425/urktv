// A "chart" is the guide for a song: timed lyrics, and optionally the melody to score against.
// Users bring their own chart files (UltraStar .txt for melody + lyrics, .lrc for lyrics only).

export interface Note {
  start: number; // seconds
  end: number;
  midi: number;
  text: string;
  kind: 'normal' | 'golden' | 'free';
  line: number;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  /** Syllables for karaoke-style highlighting (empty for plain LRC lines). */
  parts: { start: number; end: number; text: string }[];
}

export interface Chart {
  title?: string;
  artist?: string;
  notes: Note[];
  lines: LyricLine[];
  hasPitch: boolean;
}

export type ChartKind = 'ultrastar' | 'lrc';

export function detectKind(raw: string): ChartKind | null {
  if (/^\s*#(TITLE|BPM|ARTIST)\s*:/im.test(raw) && /^[:*FRG]\s+-?\d+/m.test(raw)) return 'ultrastar';
  if (/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/m.test(raw)) return 'lrc';
  return null;
}

export function parseChart(raw: string, kind?: ChartKind): Chart {
  const k = kind ?? detectKind(raw);
  if (k === 'ultrastar') return parseUltraStar(raw);
  if (k === 'lrc') return parseLrc(raw);
  throw new Error('unknown chart format');
}

/** UltraStar: beats are quarter-beats of #BPM; pitch 0 = C4; #GAP is ms before beat 0. */
export function parseUltraStar(raw: string): Chart {
  const head: Record<string, string> = {};
  const notes: Note[] = [];
  let line = 0;
  let rel = 0;
  const rows = raw.replace(/^﻿/, '').split(/\r?\n/);

  for (const row of rows) {
    const m = /^#([A-Za-z0-9]+)\s*:(.*)$/.exec(row);
    if (m) head[m[1].toUpperCase()] = m[2].trim();
  }
  const bpm = parseFloat((head.BPM ?? '').replace(',', '.'));
  if (!(bpm > 0)) throw new Error('missing #BPM');
  const gap = parseFloat((head.GAP ?? '0').replace(',', '.')) / 1000 || 0;
  const relative = /^yes$/i.test(head.RELATIVE ?? '');
  const beat = 60 / (bpm * 4);
  const at = (b: number) => gap + b * beat;

  for (const row of rows) {
    const c = row[0];
    if (c === 'E') break;
    if (c === '-') {
      const nums = row.slice(1).trim().split(/\s+/).map(Number);
      if (relative) rel += nums[1] ?? nums[0] ?? 0;
      if (notes.length && notes[notes.length - 1].line === line) line++;
      continue;
    }
    if (c !== ':' && c !== '*' && c !== 'F' && c !== 'R' && c !== 'G') continue;
    const m = /^.\s+(-?\d+)\s+(\d+)\s+(-?\d+)(?: (.*))?$/.exec(row);
    if (!m) continue;
    const b0 = Number(m[1]) + (relative ? rel : 0);
    const len = Number(m[2]);
    notes.push({
      start: at(b0),
      end: at(b0 + len),
      midi: 60 + Number(m[3]),
      text: m[4] ?? '',
      // rap notes (R/G) have no pitch to judge, treat like freestyle
      kind: c === '*' ? 'golden' : c === ':' ? 'normal' : 'free',
      line,
    });
  }
  if (!notes.length) throw new Error('no notes');
  notes.sort((a, b) => a.start - b.start);

  const lines: LyricLine[] = [];
  for (const n of notes) {
    let l = lines[n.line];
    if (!l) l = lines[n.line] = { start: n.start, end: n.end, text: '', parts: [] };
    l.end = Math.max(l.end, n.end);
    l.parts.push({ start: n.start, end: n.end, text: n.text });
  }
  const packed = lines.filter(Boolean);
  for (const l of packed) l.text = l.parts.map((p) => p.text).join('').trim();
  return { title: head.TITLE, artist: head.ARTIST, notes, lines: packed, hasPitch: true };
}

/** LRC: "[mm:ss.xx] text". Gives lyrics only; scoring stays in free mode. */
export function parseLrc(raw: string): Chart {
  const out: { t: number; text: string }[] = [];
  let title: string | undefined;
  let artist: string | undefined;
  let offset = 0;
  for (const row of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const tag = /^\s*\[(ti|ar|offset)\s*:(.*)\]\s*$/i.exec(row);
    if (tag) {
      const key = tag[1].toLowerCase();
      if (key === 'ti') title = tag[2].trim();
      else if (key === 'ar') artist = tag[2].trim();
      else offset = Number(tag[2]) / 1000 || 0;
      continue;
    }
    const stamps = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = row.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const s of stamps) {
      const frac = s[3] ? Number('0.' + s[3]) : 0;
      out.push({ t: Number(s[1]) * 60 + Number(s[2]) + frac - offset, text });
    }
  }
  if (!out.length) throw new Error('no timed lines');
  out.sort((a, b) => a.t - b.t);
  const lines: LyricLine[] = [];
  out.forEach((o, i) => {
    if (!o.text) return;
    const next = out[i + 1]?.t ?? o.t + 6;
    lines.push({ start: o.t, end: Math.min(next, o.t + 12), text: o.text, parts: [] });
  });
  return { title, artist, notes: [], lines, hasPitch: false };
}

/** Index of the note sounding at time t, or -1. Notes must be sorted by start. */
export function noteAt(notes: Note[], t: number): number {
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].end <= t) lo = mid + 1;
    else if (notes[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/** Index of the line being sung at t, or the next upcoming one; -1 after the last. */
export function lineAt(lines: LyricLine[], t: number): number {
  for (let i = 0; i < lines.length; i++) if (t < lines[i].end) return i;
  return -1;
}
