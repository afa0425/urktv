// Monophonic pitch detection (McLeod Pitch Method / normalised square difference).
// Pure function, no Web Audio dependency, so it is unit-testable.

export interface PitchResult {
  freq: number;
  /** 0..1, how periodic the frame is. Voices are usually > 0.8. */
  clarity: number;
}

export const MIN_FREQ = 70; // below a bass's low E
export const MAX_FREQ = 1100; // above a soprano's high C

export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

let nsdf = new Float32Array(0);

export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  minClarity = 0.8,
  minRms = 0.008,
): PitchResult | null {
  if (rms(buf) < minRms) return null;

  const n = buf.length;
  const maxTau = Math.min(Math.floor(sampleRate / MIN_FREQ), n >> 1);
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
  if (nsdf.length < maxTau + 1) nsdf = new Float32Array(maxTau + 1);

  for (let tau = 0; tau <= maxTau; tau++) {
    let acf = 0;
    let div = 0;
    const lim = n - tau;
    for (let i = 0; i < lim; i++) {
      const a = buf[i];
      const b = buf[i + tau];
      acf += a * b;
      div += a * a + b * b;
    }
    nsdf[tau] = div > 0 ? (2 * acf) / div : 0;
  }

  // Collect the highest point of every positive lobe after the first zero crossing.
  const peaks: number[] = [];
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau++;
  let best = -1;
  for (; tau < maxTau; tau++) {
    if (nsdf[tau] > 0) {
      if (nsdf[tau] > nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
        if (best < 0 || nsdf[tau] > nsdf[best]) best = tau;
      }
    } else if (best >= 0) {
      peaks.push(best);
      best = -1;
    }
  }
  if (best >= 0) peaks.push(best);
  if (!peaks.length) return null;

  let top = 0;
  for (const p of peaks) if (nsdf[p] > top) top = nsdf[p];
  if (top < minClarity) return null;

  // First peak close to the best one = the fundamental (avoids octave-down errors).
  const pick = peaks.find((p) => nsdf[p] >= 0.9 * top && p >= minTau);
  if (pick === undefined) return null;

  // Parabolic interpolation around the peak for sub-sample accuracy.
  const y0 = nsdf[pick - 1];
  const y1 = nsdf[pick];
  const y2 = nsdf[pick + 1];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const freq = sampleRate / (pick + shift);
  if (freq < MIN_FREQ || freq > MAX_FREQ) return null;
  return { freq, clarity: y1 };
}

export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function midiName(m: number): string {
  const r = Math.round(m);
  return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}
