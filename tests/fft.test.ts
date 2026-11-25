import { describe, expect, it } from 'vitest';
import { FFT } from '../src/separate/fft';

function dft(re: number[], im: number[]) {
  const n = re.length;
  const R: number[] = [], I: number[] = [];
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
    R.push(sr); I.push(si);
  }
  return [R, I];
}

describe('mixed-radix FFT', () => {
  it.each([2, 3, 4, 5, 6, 8, 12, 15, 30, 48, 60, 96, 120, 240, 384])('matches a direct DFT at n=%i', (n) => {
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
    const re = Array.from({ length: n }, rnd), im = Array.from({ length: n }, rnd);
    const [R, I] = dft(re, im);
    const f = new FFT(n);
    const a = Float64Array.from(re), b = Float64Array.from(im);
    f.transform(a, b);
    for (let k = 0; k < n; k++) {
      expect(a[k]).toBeCloseTo(R[k], 8);
      expect(b[k]).toBeCloseTo(I[k], 8);
    }
    f.transform(a, b, true);
    for (let k = 0; k < n; k++) expect(a[k] / n).toBeCloseTo(re[k], 9);
  });
  it('handles the MDX sizes', () => {
    for (const n of [6144, 7680, 5120]) {
      const f = new FFT(n);
      const a = new Float64Array(n), b = new Float64Array(n);
      a[1] = 1;
      f.transform(a, b);
      expect(a[3]).toBeCloseTo(Math.cos((-2 * Math.PI * 3) / n), 9);
      expect(b[3]).toBeCloseTo(Math.sin((-2 * Math.PI * 3) / n), 9);
    }
  });
});
