import { describe, expect, it } from 'vitest';
import { _Spectral, separate, type MdxConfig } from '../src/separate/mdx';

const cfg: MdxConfig = { nFft: 512, dimF: 257, dimT: 32, hop: 128, compensate: 1, primary: 'instrumental' };

describe('MDX spectral transforms', () => {
  it('istft(stft(x)) reconstructs the signal when all bins are kept', () => {
    const sp = new _Spectral(cfg);
    const n = sp.chunk;
    const L = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.31));
    const R = Float32Array.from({ length: n }, (_, i) => Math.cos(i * 0.02));
    const spec = new Float32Array(4 * cfg.dimF * cfg.dimT);
    sp.stft([L, R], spec);
    const [l, r] = sp.istft(spec);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(l[i] - L[i]), Math.abs(r[i] - R[i]));
    expect(err).toBeLessThan(1e-4);
  });
  it('identity "model" returns the mix as the primary stem across chunk borders', async () => {
    const n = 20000;
    const L = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.013));
    const R = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.029));
    const st = await separate(L, R, cfg, async (x) => x.slice());
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(st.instrumental[0][i] - L[i]), Math.abs(st.vocals[1][i]));
    expect(err).toBeLessThan(1e-4);
  });
});
