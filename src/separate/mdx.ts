// MDX-Net source separation (the open UVR models), framework-free so it runs in a Web Worker or in Node.
// Input: stereo 44.1 kHz. Output: the model's primary stem; the other stem = mix - primary.
import { FFT } from './fft';

export interface MdxConfig {
  nFft: number;
  dimF: number;
  dimT: number; // frames per chunk
  hop: number;
  compensate: number;
  primary: 'instrumental' | 'vocals';
}

export const MODELS: Record<string, MdxConfig & { file: string; label: string }> = {
  inst_hq3: { file: 'UVR-MDX-NET-Inst_HQ_3.onnx', label: 'Inst HQ 3', nFft: 6144, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.022, primary: 'instrumental' },
  kim_vocal2: { file: 'Kim_Vocal_2.onnx', label: 'Kim Vocal 2', nFft: 7680, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.009, primary: 'vocals' },
  kara2: { file: 'UVR_MDXNET_KARA_2.onnx', label: 'Karaoke 2', nFft: 5120, dimF: 2048, dimT: 256, hop: 1024, compensate: 1.065, primary: 'instrumental' },
};

/** Runs the network on one [1, 4, dimF, dimT] spectrogram and returns the same shape. */
export type RunModel = (input: Float32Array, dims: number[]) => Promise<Float32Array>;

export interface Stems {
  instrumental: [Float32Array, Float32Array];
  vocals: [Float32Array, Float32Array];
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // periodic, like torch
  return w;
}

class Spectral {
  readonly fft: FFT;
  readonly win: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  readonly chunk: number;
  private envInv: Float64Array;

  constructor(private c: MdxConfig) {
    this.fft = new FFT(c.nFft);
    this.win = hann(c.nFft);
    this.re = new Float64Array(c.nFft);
    this.im = new Float64Array(c.nFft);
    this.chunk = c.hop * (c.dimT - 1);
    // window-square overlap envelope for the inverse (torch.istft normalisation)
    const len = this.chunk + c.nFft;
    const env = new Float64Array(len);
    for (let t = 0; t < c.dimT; t++) for (let i = 0; i < c.nFft; i++) env[t * c.hop + i] += this.win[i] * this.win[i];
    this.envInv = env.map((v) => (v > 1e-10 ? 1 / v : 0));
  }

  /** wave: two channels of `chunk` samples -> [4, dimF, dimT] as (L re, L im, R re, R im). */
  stft(ch: Float32Array[], out: Float32Array) {
    const { nFft, dimF, dimT, hop } = this.c;
    const pad = nFft / 2;
    const n = this.chunk;
    for (let c = 0; c < 2; c++) {
      const x = ch[c];
      for (let t = 0; t < dimT; t++) {
        const start = t * hop - pad;
        for (let i = 0; i < nFft; i++) {
          let j = start + i;
          // reflect padding, as torch.stft(center=True)
          if (j < 0) j = -j;
          else if (j >= n) j = 2 * (n - 1) - j;
          this.re[i] = x[j] * this.win[i];
          this.im[i] = 0;
        }
        this.fft.transform(this.re, this.im);
        const bRe = (c * 2) * dimF * dimT;
        const bIm = (c * 2 + 1) * dimF * dimT;
        for (let f = 0; f < dimF; f++) {
          out[bRe + f * dimT + t] = this.re[f];
          out[bIm + f * dimT + t] = this.im[f];
        }
      }
    }
  }

  /** Inverse of stft(); returns two channels of `chunk` samples. */
  istft(spec: Float32Array): Float32Array[] {
    const { nFft, dimF, dimT, hop } = this.c;
    const half = nFft / 2;
    const len = this.chunk + nFft;
    const res: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const acc = new Float64Array(len);
      const bRe = (c * 2) * dimF * dimT;
      const bIm = (c * 2 + 1) * dimF * dimT;
      for (let t = 0; t < dimT; t++) {
        this.re.fill(0);
        this.im.fill(0);
        for (let f = 0; f < dimF; f++) {
          this.re[f] = spec[bRe + f * dimT + t];
          this.im[f] = spec[bIm + f * dimT + t];
        }
        // Hermitian symmetry for a real signal (bins dimF..half stay 0, as in the model's training)
        for (let f = 1; f < half; f++) {
          this.re[nFft - f] = this.re[f];
          this.im[nFft - f] = -this.im[f];
        }
        this.im[0] = 0;
        this.im[half] = 0;
        this.fft.transform(this.re, this.im, true);
        const o = t * hop;
        for (let i = 0; i < nFft; i++) acc[o + i] += (this.re[i] / nFft) * this.win[i];
      }
      const y = new Float32Array(this.chunk);
      for (let i = 0; i < this.chunk; i++) y[i] = acc[i + half] * this.envInv[i + half];
      res.push(y);
    }
    return res;
  }
}

/**
 * Separates a whole song. Chunks overlap by nFft/2 on each side (the edges are thrown away),
 * so there are no clicks at chunk borders.
 */
export async function separate(
  left: Float32Array,
  right: Float32Array,
  cfg: MdxConfig,
  run: RunModel,
  onProgress?: (done: number, total: number) => void,
): Promise<Stems> {
  const sp = new Spectral(cfg);
  const chunk = sp.chunk;
  const trim = cfg.nFft / 2;
  const gen = chunk - 2 * trim;
  const n = left.length;
  const padded = Math.ceil(n / gen) * gen;
  const total = padded / gen;
  const pL = new Float32Array(padded + 2 * trim);
  const pR = new Float32Array(padded + 2 * trim);
  pL.set(left, trim);
  pR.set(right, trim);

  const primL = new Float32Array(padded);
  const primR = new Float32Array(padded);
  const spec = new Float32Array(4 * cfg.dimF * cfg.dimT);
  const dims = [1, 4, cfg.dimF, cfg.dimT];
  for (let k = 0; k < total; k++) {
    const i = k * gen;
    sp.stft([pL.subarray(i, i + chunk), pR.subarray(i, i + chunk)], spec);
    const out = await run(spec, dims);
    const [yL, yR] = sp.istft(out);
    primL.set(yL.subarray(trim, trim + gen), i);
    primR.set(yR.subarray(trim, trim + gen), i);
    onProgress?.(k + 1, total);
  }

  const a: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const b: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  const src = [left, right];
  const prim = [primL, primR];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) {
      const p = prim[c][i] * cfg.compensate;
      a[c][i] = p;
      b[c][i] = src[c][i] - p;
    }
  }
  return cfg.primary === 'instrumental' ? { instrumental: a, vocals: b } : { vocals: a, instrumental: b };
}

export { Spectral as _Spectral };
