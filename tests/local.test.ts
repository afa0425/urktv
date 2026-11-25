import { describe, expect, it } from 'vitest';
import { parseUltraStar } from '../src/core/chart';
import { toUltraStar } from '../src/core/transport';
import { fromInt16, toInt16 } from '../src/separate/db';

describe('own-song helpers', () => {
  it('exported guide notes read back as the same melody', () => {
    const notes = [
      { start: 1.0, end: 1.4, midi: 62, text: '', kind: 'normal' as const, line: 0 },
      { start: 1.5, end: 2.2, midi: 64, text: '', kind: 'normal' as const, line: 0 },
      { start: 4.0, end: 4.6, midi: 59, text: '', kind: 'normal' as const, line: 1 },
    ];
    const c = parseUltraStar(toUltraStar('Mine', notes));
    expect(c.title).toBe('Mine');
    expect(c.notes.map((n) => n.midi)).toEqual([62, 64, 59]);
    expect(c.notes.map((n) => n.line)).toEqual([0, 0, 1]);
    c.notes.forEach((n, i) => {
      expect(Math.abs(n.start - notes[i].start)).toBeLessThan(0.03);
      expect(Math.abs(n.end - notes[i].end)).toBeLessThan(0.06);
    });
  });
  it('packs tracks to 16-bit and back', () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1, -1, 2]);
    const r = Float32Array.from([0.25, -0.25, 0, 0, 0.1, -2]);
    const [a, b] = fromInt16(toInt16([l, r]), 2);
    expect(a[1]).toBeCloseTo(0.5, 3);
    expect(b[0]).toBeCloseTo(0.25, 3);
    expect(a[5]).toBeCloseTo(1, 3); // clipped
    expect(b[5]).toBeCloseTo(-1, 3);
  });
});
