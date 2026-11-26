import { noteAt, type Chart } from './chart';

export type Difficulty = 'easy' | 'normal' | 'hard';
/** How far (in semitones) from the target still counts as a hit. */
export const TOLERANCE: Record<Difficulty, number> = { easy: 2, normal: 1, hard: 0.5 };

export interface ScorePart {
  key: string; // i18n key suffix
  value: number; // 0..1
}

/** What the result screen celebrates (layered songs). */
export interface ScoreExtras {
  maxCombo: number;
  highNotesHit: number;
  highNotesTotal: number;
  highestHit: number | null; // MIDI of the highest target note sung right
  bestLine: { text: string; ratio: number } | null;
  similarity: number; // 0..1 share of notes sung on pitch
  titles: string[]; // i18n keys under result.title.*
}

export interface ScoreResult {
  mode: 'guide' | 'free';
  extras?: ScoreExtras;
  score: number; // 0..100
  grade: string;
  parts: ScorePart[];
  voicedSec: number;
  lowMidi: number | null;
  highMidi: number | null;
}

/** Difference user - target in semitones, ignoring octaves: result in (-6, 6]. */
export function foldDiff(user: number, target: number): number {
  let d = (user - target) % 12;
  if (d > 6) d -= 12;
  if (d <= -6) d += 12;
  return d + 0; // never -0
}

/** Move the user's pitch into the octave nearest the target, for display. */
export const foldNear = (user: number, target: number) => target + foldDiff(user, target);

export function gradeOf(score: number): string {
  if (score >= 95) return 'SSS';
  if (score >= 90) return 'SS';
  if (score >= 85) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

abstract class Base {
  protected pitches: number[] = [];
  protected voicedSec = 0;
  protected track(midi: number | null, dt: number) {
    if (midi === null) return;
    this.voicedSec += dt;
    if (this.pitches.length < 40000) this.pitches.push(midi);
  }
  protected range(): [number | null, number | null] {
    if (this.pitches.length < 10) return [null, null];
    const s = [...this.pitches].sort((a, b) => a - b);
    return [percentile(s, 0.05), percentile(s, 0.95)];
  }
}

// Nobody holds a pitch for 100% of a note (consonants, breaths), so this much counts as full marks.
const FULL_NOTE = 0.75;

/**
 * KTV-style friendly curve: the raw share of notes sung right, lifted so that ordinary singing
 * lands in the 60s-80s (100 stays 100, 0 stays 0). A low score makes nobody sing again.
 */
export const friendly = (raw: number) => (raw <= 0 ? 0 : 100 * Math.pow(Math.min(100, raw) / 100, 0.6));

/** Scores against the melody of a chart, per note, octave-agnostic. */
export class GuideScorer extends Base {
  transpose = 0;
  tolerance: number;
  private hit: Float64Array;
  private seen: Float64Array;

  constructor(
    private chart: Chart,
    difficulty: Difficulty,
  ) {
    super();
    this.tolerance = TOLERANCE[difficulty];
    this.hit = new Float64Array(chart.notes.length);
    this.seen = new Float64Array(chart.notes.length);
  }

  /** t = chart time the voice belongs to (latency already removed), dt = seconds this frame covers. */
  push(t: number, midi: number | null, dt: number): { index: number; hit: boolean } {
    this.track(midi, dt);
    const i = noteAt(this.chart.notes, t);
    if (i < 0) return { index: -1, hit: false };
    const n = this.chart.notes[i];
    const len = n.end - n.start;
    this.seen[i] = Math.min(len, this.seen[i] + dt);
    let ok = false;
    if (midi !== null) {
      ok = n.kind === 'free' || Math.abs(foldDiff(midi, n.midi + this.transpose)) <= this.tolerance;
      if (ok) this.hit[i] = Math.min(len, this.hit[i] + dt);
    }
    return { index: i, hit: ok };
  }

  /** 0..1: how much of note i was sung on pitch so far. */
  noteRatio(i: number): number {
    return this.ratio(i);
  }

  private ratio(i: number): number {
    const n = this.chart.notes[i];
    return Math.min(1, this.hit[i] / ((n.end - n.start) * FULL_NOTE));
  }

  /** Running score over the notes reached so far (what the HUD shows while singing). */
  live(): number {
    return friendly(this.total(true));
  }

  private total(onlySeen: boolean): number {
    let got = 0;
    let max = 0;
    this.chart.notes.forEach((n, i) => {
      if (n.kind === 'free') return;
      if (onlySeen && this.seen[i] === 0) return;
      const w = (n.end - n.start) * (n.kind === 'golden' ? 2 : 1);
      got += w * this.ratio(i);
      max += w;
    });
    return max > 0 ? (100 * got) / max : 0;
  }

  /** After a jump in the song, the result only counts the notes that were actually reached. */
  skipped = false;

  result(): ScoreResult {
    let notesHit = 0;
    let notes = 0;
    let golden = 0;
    let goldenMax = 0;
    this.chart.notes.forEach((n, i) => {
      if (n.kind === 'free') return;
      if (this.skipped && this.seen[i] === 0) return;
      notes++;
      if (this.ratio(i) >= 0.5) notesHit++;
      if (n.kind === 'golden') {
        goldenMax++;
        golden += this.ratio(i);
      }
    });
    const raw = this.total(this.skipped);
    const score = friendly(raw);
    const parts: ScorePart[] = [
      { key: 'pitch', value: raw / 100 },
      { key: 'notesHit', value: notes ? notesHit / notes : 0 },
    ];
    if (goldenMax) parts.push({ key: 'golden', value: golden / goldenMax });
    const [lowMidi, highMidi] = this.range();
    return { mode: 'guide', score, grade: gradeOf(score), parts, voicedSec: this.voicedSec, lowMidi, highMidi };
  }
}

/**
 * No melody to compare with: judges how you sing rather than what you sing.
 * It is an estimate (steady, in-tune, sustained singing scores high), not a melody check.
 */
export class FreeScorer extends Base {
  private totalSec = 0;
  private inTuneSec = 0;
  private heldSec = 0;
  private runMean = 0;
  private runSec = 0;

  push(_t: number, midi: number | null, dt: number): { index: number; hit: boolean } {
    this.totalSec += dt;
    this.track(midi, dt);
    if (midi === null) {
      this.closeRun();
      return { index: -1, hit: false };
    }
    const inTune = Math.abs(midi - Math.round(midi)) <= 0.3;
    if (inTune) this.inTuneSec += dt;
    if (this.runSec > 0 && Math.abs(midi - this.runMean) <= 0.7) {
      this.runMean += (midi - this.runMean) * 0.2;
      this.runSec += dt;
    } else {
      this.closeRun();
      this.runMean = midi;
      this.runSec = dt;
    }
    return { index: -1, hit: inTune };
  }

  private closeRun() {
    if (this.runSec >= 0.35) this.heldSec += this.runSec;
    this.runSec = 0;
  }

  private compute() {
    const held = this.heldSec + (this.runSec >= 0.35 ? this.runSec : 0);
    const v = this.voicedSec;
    const [low, high] = this.range();
    return {
      inTune: v > 0 ? this.inTuneSec / v : 0,
      coverage: this.totalSec > 0 ? Math.min(1, v / (this.totalSec * 0.4)) : 0,
      sustain: v > 0 ? Math.min(1, held / v / 0.6) : 0,
      range: low !== null && high !== null ? Math.min(1, (high - low) / 12) : 0,
      low,
      high,
    };
  }

  live(): number {
    const c = this.compute();
    // Until there is some singing to judge, do not show a number that jumps around.
    if (this.voicedSec < 2) return 0;
    return 100 * (0.4 * c.inTune + 0.25 * c.coverage + 0.25 * c.sustain + 0.1 * c.range);
  }

  result(): ScoreResult {
    const c = this.compute();
    const score = this.voicedSec < 2 ? 0 : this.live();
    return {
      mode: 'free',
      score,
      grade: gradeOf(score),
      parts: [
        { key: 'inTune', value: c.inTune },
        { key: 'coverage', value: c.coverage },
        { key: 'sustain', value: c.sustain },
        { key: 'range', value: c.range },
      ],
      voicedSec: this.voicedSec,
      lowMidi: c.low,
      highMidi: c.high,
    };
  }
}

export type Scorer = GuideScorer | FreeScorer;
