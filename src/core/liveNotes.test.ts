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
