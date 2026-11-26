// Key change for the backing (and the guide vocal), without changing speed: two read heads moving
// through a short delay line at the new rate, cross-faded so each restart is inaudible.
const WIN = 2048; // ~46 ms at 44.1 kHz: long enough for music, short enough to follow the song

class KeyShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2 }];
  }
  constructor() {
    super();
    this.n = WIN * 4;
    this.buf = [new Float32Array(this.n), new Float32Array(this.n)];
    this.w = 0;
    this.ph = 0; // 0..1: position of read head 1 in the window (head 2 is half a window apart)
  }
  read(ch, d) {
    let p = this.w - d;
    while (p < 0) p += this.n;
    const i = Math.floor(p);
    const f = p - i;
    const b = this.buf[ch];
    return b[i % this.n] * (1 - f) + b[(i + 1) % this.n] * f;
  }
  process(inputs, outputs, params) {
    const inp = inputs[0];
    const out = outputs[0];
    const ratio = params.ratio[0];
    const frames = out[0].length;
    for (let k = 0; k < frames; k++) {
      for (let c = 0; c < 2; c++) this.buf[c][this.w] = inp[c] ? inp[c][k] : inp[0] ? inp[0][k] : 0;
      if (Math.abs(ratio - 1) < 1e-4) {
        for (let c = 0; c < out.length; c++) out[c][k] = this.buf[Math.min(c, 1)][this.w];
      } else {
        // the delay changes by (1 - ratio) per sample: reading faster raises the pitch
        this.ph -= (ratio - 1) / WIN;
        this.ph -= Math.floor(this.ph);
        const p2 = (this.ph + 0.5) % 1;
        const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.ph);
        const g2 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p2);
        const d1 = this.ph * WIN + 2;
        const d2 = p2 * WIN + 2;
        for (let c = 0; c < out.length; c++) {
          const ch = Math.min(c, 1);
          out[c][k] = this.read(ch, d1) * g1 + this.read(ch, d2) * g2;
        }
      }
      this.w = (this.w + 1) % this.n;
    }
    return true;
  }
}
registerProcessor('key-shift', KeyShift);
