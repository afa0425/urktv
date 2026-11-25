import { describe, expect, it } from 'vitest';
import { NOTE_RATE, phraseLines, segmentNotes, trackPitch } from '../src/separate/notes';
import { midiToFreq } from '../src/audio/pitch';

/** A sung-like phrase: notes with vibrato, harmonics and small gaps. */
function phrase(spec: [number, number, number][], rate = NOTE_RATE) {
  const end = Math.max(...spec.map((s) => s[0] + s[1])) + 0.5;
  const out = new Float32Array(Math.ceil(end * rate));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const s = spec.find(([a, d]) => t >= a && t < a + d - 0.03);
    if (!s) continue;
    const f = midiToFreq(s[2]) * Math.pow(2, (0.25 * Math.sin(2 * Math.PI * 5.5 * t)) / 12);
    phase += (2 * Math.PI * f) / rate;
    out[i] = 0.3 * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase));
  }
  return out;
}

describe('guide notes from a vocal', () => {
  const spec: [number, number, number][] = [
    [0.5, 0.5, 60], [1.0, 0.5, 62], [1.5, 1.0, 64], [2.5, 0.4, 64], [2.9, 0.6, 67],
    [5.0, 0.5, 65], [5.5, 0.5, 64], [6.0, 1.2, 60],
  ];
  const notes = segmentNotes(trackPitch(phrase(spec)));
  it('finds every note with the right pitch and timing', () => {
    // repeated 64s with a short gap may merge; everything else is one note each
    const pitches = notes.map((n) => n.midi);
    expect(pitches).toEqual([60, 62, 64, 67, 65, 64, 60]);
    expect(Math.abs(notes[0].start - 0.5)).toBeLessThan(0.06);
    expect(Math.abs(notes[3].start - 2.9)).toBeLessThan(0.06);
    expect(Math.abs(notes[6].end - 7.17)).toBeLessThan(0.08);
  });
  it('groups phrases at pauses', () => {
    const lines = phraseLines(notes);
    expect(lines).toHaveLength(2);
    expect(notes.filter((n) => n.line === 1).map((n) => n.midi)).toEqual([65, 64, 60]);
  });
  it('ignores silence and quiet bleed', () => {
    const quiet = new Float32Array(NOTE_RATE * 2).map((_, i) => 0.001 * Math.sin(i));
    expect(segmentNotes(trackPitch(quiet))).toEqual([]);
  });
});
