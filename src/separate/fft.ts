// Complex FFT for any size made of the factors 2, 3 and 5 (MDX-Net uses n_fft 6144 / 7680 / 5120,
// which are not powers of two). Recursive mixed-radix Cooley–Tukey with a shared twiddle table.

export class FFT {
  readonly n: number;
  private factors: number[] = [];
  private cos: Float64Array;
  private sin: Float64Array;
  private outRe: Float64Array;
  private outIm: Float64Array;
  private sign = 1;

  constructor(n: number) {
    this.n = n;
    let m = n;
    for (const f of [4, 2, 3, 5]) {
      while (m % f === 0) {
        this.factors.push(f);
        m /= f;
      }
    }
    if (m !== 1) throw new Error(`FFT size ${n} has a prime factor other than 2, 3, 5`);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      this.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      this.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    this.outRe = new Float64Array(n);
    this.outIm = new Float64Array(n);
  }

  /** In-place transform. inverse = true gives the unscaled inverse (divide by n yourself). */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    this.sign = inverse ? -1 : 1;
    this.rec(re, im, 0, 1, 0, this.n, 0);
    re.set(this.outRe);
    im.set(this.outIm);
  }

  private rec(re: Float64Array, im: Float64Array, inOff: number, stride: number, outOff: number, n: number, fi: number) {
    const oR = this.outRe;
    const oI = this.outIm;
    if (n === 1) {
      oR[outOff] = re[inOff];
      oI[outOff] = im[inOff];
      return;
    }
    const p = this.factors[fi];
    const m = n / p;
    for (let q = 0; q < p; q++) this.rec(re, im, inOff + q * stride, stride * p, outOff + q * m, m, fi + 1);

    const N = this.n;
    const scale = N / n; // twiddle W_n^x = W_N^(x*scale)
    const C = this.cos;
    const S = this.sin;
    const sg = this.sign;
    if (p === 2) {
      for (let k = 0; k < m; k++) {
        const a = outOff + k;
        const b = a + m;
        const t = k * scale;
        const wr = C[t], wi = sg * S[t];
        const br = oR[b] * wr - oI[b] * wi;
        const bi = oR[b] * wi + oI[b] * wr;
        const ar = oR[a], ai = oI[a];
        oR[a] = ar + br; oI[a] = ai + bi;
        oR[b] = ar - br; oI[b] = ai - bi;
      }
      return;
    }
    if (p === 4) {
      for (let k = 0; k < m; k++) {
        const i0 = outOff + k, i1 = i0 + m, i2 = i1 + m, i3 = i2 + m;
        const t1 = k * scale, t2 = 2 * t1, t3 = 3 * t1;
        const x0r = oR[i0], x0i = oI[i0];
        let wr = C[t1], wi = sg * S[t1];
        const x1r = oR[i1] * wr - oI[i1] * wi, x1i = oR[i1] * wi + oI[i1] * wr;
        wr = C[t2]; wi = sg * S[t2];
        const x2r = oR[i2] * wr - oI[i2] * wi, x2i = oR[i2] * wi + oI[i2] * wr;
        wr = C[t3]; wi = sg * S[t3];
        const x3r = oR[i3] * wr - oI[i3] * wi, x3i = oR[i3] * wi + oI[i3] * wr;
        const s02r = x0r + x2r, s02i = x0i + x2i, d02r = x0r - x2r, d02i = x0i - x2i;
        const s13r = x1r + x3r, s13i = x1i + x3i, d13r = x1r - x3r, d13i = x1i - x3i;
        // multiply d13 by -i (forward) or +i (inverse)
        const jr = sg * d13i, ji = -sg * d13r;
        oR[i0] = s02r + s13r; oI[i0] = s02i + s13i;
        oR[i1] = d02r + jr; oI[i1] = d02i + ji;
        oR[i2] = s02r - s13r; oI[i2] = s02i - s13i;
        oR[i3] = d02r - jr; oI[i3] = d02i - ji;
      }
      return;
    }
    // generic radix (3, 5)
    const xr = new Float64Array(p);
    const xi = new Float64Array(p);
    for (let k = 0; k < m; k++) {
      for (let q = 0; q < p; q++) {
        const idx = outOff + q * m + k;
        const t = (q * k * scale) % N;
        const wr = C[t], wi = sg * S[t];
        xr[q] = oR[idx] * wr - oI[idx] * wi;
        xi[q] = oR[idx] * wi + oI[idx] * wr;
      }
      for (let s = 0; s < p; s++) {
        let sr = 0, si = 0;
        for (let q = 0; q < p; q++) {
          const t = (((q * s) % p) * (N / p)) % N;
          const wr = C[t], wi = sg * S[t];
          sr += xr[q] * wr - xi[q] * wi;
          si += xr[q] * wi + xi[q] * wr;
        }
        oR[outOff + s * m + k] = sr;
        oI[outOff + s * m + k] = si;
      }
    }
  }
}
