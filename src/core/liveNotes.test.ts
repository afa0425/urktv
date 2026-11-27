import { describe, expect, it } from 'vitest';
import { LiveNotes, offsetBounds } from './liveNotes';

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

describe('bars stay put', () => {
  it('keeps earlier bars unchanged when more of the song arrives', () => {
    const hop = 512 / 22050;
    const song: (number | null)[] = [];
    for (let t = 0; t < 30; t += hop) song.push(Math.floor(t) % 3 === 2 ? null : 60 + (Math.floor(t / 3) % 5));
    const ln = new LiveNotes();
    const half = Math.floor(song.length / 2);
    ln.add(0, hop, song.slice(0, half));
    const early = ln.between(0, 10).map((n) => `${n.start.toFixed(3)}-${n.end.toFixed(3)}-${n.midi}`);
    expect(early.length).toBeGreaterThan(3);
    ln.add(half * hop, hop, song.slice(half));
    expect(ln.between(0, 10).map((n) => `${n.start.toFixed(3)}-${n.end.toFixed(3)}-${n.midi}`)).toEqual(early);
    // and the same call twice gives the very same bars (no work per picture)
    expect(ln.all()).toBe(ln.all());
  });

  it('only looks for the lyric shift where it can be', () => {
    const lines = [10, 16, 22, 30, 38, 45].map((s) => ({ start: s, end: s + 4 }));
    const ln = new LiveNotes();
    const hop = 512 / 22050;
    const midi: (number | null)[] = [];
    for (let t = 0; t < 60; t += hop) midi.push(lines.some((l) => t >= l.start + 7.3 && t < l.end + 6.8) ? 60 : null);
    ln.add(0, hop, midi);
    const r = ln.alignOffset(lines, [-2.5, 2.5])!;
    expect(Math.abs(r.off)).toBeLessThanOrEqual(2.5);
  });
});

describe('offsetBounds', () => {
  it('trusts the timing when the MV is as long as the recording', () => {
    expect(offsetBounds(240, 239)).toBeNull();
  });
  it('lets the lyrics move only as far as the MV is longer', () => {
    expect(offsetBounds(264, 241)).toEqual([-3, 26]);
    expect(offsetBounds(200, 240)).toEqual([-43, 3]);
  });
  it('searches wide when a length is unknown', () => {
    expect(offsetBounds(0, 240)).toBe(60);
  });
});
