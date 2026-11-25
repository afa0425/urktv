// Key change without changing tempo: phase-vocoder time stretch (with identity phase locking),
// then resampling back to the original length.
import { FFT } from './fft';

const N = 2048;
const HA = 512;

function hann(n: number) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

const wrap = (p: number) => p - 2 * Math.PI * Math.round(p / (2 * Math.PI));

function stretch(x: Float32Array, ratio: number, fft: FFT, win: Float64Array): Float32Array {
  const hs = HA * ratio;
  const half = N / 2;
  const frames = Math.max(1, Math.floor((x.length + N) / HA));
  const outLen = Math.ceil(frames * hs + 2 * N);
  const out = new Float64Array(outLen);
  const env = new Float64Array(outLen);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(half + 1);
  const ph = new Float64Array(half + 1);
  const prev = new Float64Array(half + 1);
  const acc = new Float64Array(half + 1);
  const peakOf = new Int32Array(half + 1);
  let first = true;

  for (let f = 0; f < frames; f++) {
    const a = f * HA - N; // pad N at the start so the beginning is not lost
    for (let i = 0; i < N; i++) {
      const j = a + i;
      re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }
    // peaks, and each bin's nearest peak (identity phase locking keeps partials coherent)
    const peaks: number[] = [];
    for (let k = 2; k < half - 1; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > mag[k - 2] && mag[k] >= mag[k + 2]) peaks.push(k);
    }
    if (!peaks.length) peaks.push(0);
    let p = 0;
    for (let k = 0; k <= half; k++) {
      while (p + 1 < peaks.length && Math.abs(peaks[p + 1] - k) < Math.abs(peaks[p] - k)) p++;
      peakOf[k] = peaks[p];
    }
    for (const k of peaks) {
      if (first) acc[k] = ph[k];
      else {
        const omega = (2 * Math.PI * k * HA) / N;
        const dev = wrap(ph[k] - prev[k] - omega);
        acc[k] += ((omega + dev) * hs) / HA;
      }
    }
    for (let k = 0; k <= half; k++) {
      const pk = peakOf[k];
      const sp = first ? ph[k] : acc[pk] + (ph[k] - ph[pk]);
      re[k] = mag[k] * Math.cos(sp);
      im[k] = mag[k] * Math.sin(sp);
      if (k > 0 && k < half) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    im[0] = 0;
    im[half] = 0;
    prev.set(ph);
    first = false;
    fft.transform(re, im, true);
    const o = Math.round(f * hs);
    for (let i = 0; i < N; i++) {
      out[o + i] += (re[i] / N) * win[i];
      env[o + i] += win[i] * win[i];
    }
  }
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) y[i] = env[i] > 1e-6 ? out[i] / env[i] : 0;
  return y;
}

/** Shifts the pitch by `semitones`, keeping the length (and so the tempo and the sync with the video). */
export function pitchShift(x: Float32Array, semitones: number): Float32Array {
  if (!semitones) return x.slice();
  const ratio = Math.pow(2, semitones / 12);
  const fft = new FFT(N);
  const win = hann(N);
  const s = stretch(x, ratio, fft, win);
  const lead = N * ratio; // the padding added at the start, in stretched samples
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    // read the stretched signal `ratio` times faster: cubic interpolation
    const t = lead + i * ratio;
    const j = Math.floor(t);
    const u = t - j;
    const p0 = s[j - 1] ?? 0, p1 = s[j] ?? 0, p2 = s[j + 1] ?? 0, p3 = s[j + 2] ?? 0;
    y[i] = p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)));
  }
  return y;
}
