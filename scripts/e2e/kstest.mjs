import { readFileSync } from 'node:fs';
let Proc;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_n, c) => (Proc = c);
eval(readFileSync('/home/user/urktv/extension/pitch-worklet.js', 'utf8'));
for (const semis of [2, -3, 5]) {
  const p = new Proc();
  const ratio = 2 ** (semis / 12);
  const sr = 44100, N = 128 * 690, f = 440;
  const out = new Float32Array(N);
  for (let o = 0; o < N; o += 128) {
    const a = new Float32Array(128).map((_, k) => Math.sin((2 * Math.PI * f * (o + k)) / sr));
    const o0 = new Float32Array(128), o1 = new Float32Array(128);
    p.process([[a, a]], [[o0, o1]], { ratio: [ratio] });
    out.set(o0, o);
  }
  // frequency by zero crossings over the second half
  let z = 0;
  for (let i = N / 2 + 1; i < N; i++) if (out[i - 1] < 0 && out[i] >= 0) z++;
  const est = z / ((N / 2) / sr);
  console.log(`key ${semis > 0 ? '+' : ''}${semis}: want ${(f * ratio).toFixed(1)} Hz, got ${est.toFixed(1)} Hz`);
}
