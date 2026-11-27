import { describe, expect, it } from 'vitest';
import { LiveNotes } from './liveNotes';
import { coverage, packBars, unpackBars } from './sheet';

describe('song sheet bars', () => {
  it('come back the same after packing, with unheard frames left unheard', () => {
    const a = new LiveNotes();
    const hop = 512 / 22050;
    a.add(10, hop, [60, 60.5, null, null, 62]);
    a.add(20, hop, [64, null]);
    const d = a.dump()!;
    const back = unpackBars({ hop: d.hop, k0: d.k0, q: 1, cover: 1, data: packBars(d) });
    expect([...back.data]).toEqual([...d.data]);
    const b = new LiveNotes();
    b.restore(back);
    // 7 frames heard, the gap between 10 s and 20 s is not "silence"
    expect(b.heard()).toBeCloseTo(7 * hop, 5);
    expect(coverage(d, 7 * hop)).toBeCloseTo(1, 5);
    expect(coverage(d, 70 * hop)).toBeCloseTo(0.1, 5);
  });
});
