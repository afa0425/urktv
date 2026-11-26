import { describe, expect, it } from 'vitest';
import { LiveNotes } from './liveNotes';

describe('LiveNotes', () => {
  it('finds where the lyrics belong from the sung parts', () => {
    const lines = [10, 16, 22, 30, 38, 45].map((s) => ({ start: s, end: s + 4 }));
    const shift = 7.3; // the MV has 7.3 s more intro than the album
    const ln = new LiveNotes();
    const hop = 512 / 22050;
    const midi: (number | null)[] = [];
    for (let t = 0; t < 60; t += hop) midi.push(lines.some((l) => t >= l.start + shift && t < l.end + shift - 0.5) ? 60 : null);
    ln.add(0, hop, midi);
    expect(ln.alignOffset(lines)!.off).toBeCloseTo(shift, 0);
    // bars come out of the same frames
    expect(ln.between(17, 22).length).toBeGreaterThan(0);
  });
});

describe('charTimes', () => {
  it('spreads characters over the sung moments only', () => {
    const ln = new LiveNotes();
    const hop = 512 / 22050;
    const midi: (number | null)[] = [];
    // sings 1.0-2.0 and 3.0-4.0, silent between
    for (let t = 0; t < 5; t += hop) midi.push((t >= 1 && t < 2) || (t >= 3 && t < 4) ? 62 : null);
    ln.add(0, hop, midi);
    const p = ln.charTimes('我愛你嗎', 0.5, 4.5)!;
    expect(p[0].start).toBeCloseTo(1, 1);
    expect(p[2].start).toBeCloseTo(3, 1); // third character waits for the second phrase
    expect(p[3].end).toBeCloseTo(4, 1);
  });
});
