import { describe, expect, it } from 'vitest';
import { pitchShift } from '../src/separate/pitchshift';
import { detectPitch, freqToMidi, rms } from '../src/audio/pitch';

const SR = 44100;
const tone = (f: number, secs: number) =>
  Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => {
    const p = (2 * Math.PI * f * i) / SR;
    return 0.3 * (Math.sin(p) + 0.4 * Math.sin(2 * p));
  });

function midiAt(x: Float32Array, at: number) {
  const o = Math.round(at * SR);
  return freqToMidi(detectPitch(x.subarray(o, o + 2048), SR)!.freq);
}

describe('key change', () => {
  it.each([3, -3, 5, -6, 1])('moves A4 by %i semitones and keeps the length', (k) => {
    const x = tone(440, 1.5);
    const y = pitchShift(x, k);
    expect(y.length).toBe(x.length);
    expect(midiAt(y, 0.7)).toBeCloseTo(69 + k, 1);
    expect(rms(y.subarray(SR * 0.3, SR * 1.2))).toBeGreaterThan(0.5 * rms(x.subarray(SR * 0.3, SR * 1.2)));
  });
  it('keeps timing: a tone starting at 1 s still starts at 1 s', () => {
    const x = new Float32Array(SR * 2);
    x.set(tone(330, 0.8), SR);
    const y = pitchShift(x, 4);
    expect(rms(y.subarray(SR * 0.6, SR * 0.9))).toBeLessThan(0.01);
    expect(rms(y.subarray(SR * 1.1, SR * 1.4))).toBeGreaterThan(0.1);
  });
});
