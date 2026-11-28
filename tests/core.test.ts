import { describe, expect, it } from 'vitest';
import { detectPitch, freqToMidi, midiName, midiToFreq } from '../src/audio/pitch';
import { detectKind, lineAt, noteAt, parseLrc, parseUltraStar } from '../src/core/chart';
import { foldDiff, FreeScorer, gradeOf, GuideScorer } from '../src/core/score';
import { demoChart, parseVideoId } from '../src/core/transport';
import { nearestNote } from '../src/ui/lane';

const SR = 48000;
/** A voice-like tone: fundamental plus weaker harmonics. */
function tone(freq: number, n = 2048, amp = 0.3): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (2 * Math.PI * freq * i) / SR;
    b[i] = amp * (Math.sin(p) + 0.5 * Math.sin(2 * p) + 0.25 * Math.sin(3 * p));
  }
  return b;
}

describe('pitch detection', () => {
  it.each([82.4, 110, 196, 261.63, 440, 659.25, 987.77])('finds %f Hz within 10 cents', (f) => {
    const r = detectPitch(tone(f), SR);
    expect(r).not.toBeNull();
    expect(Math.abs(freqToMidi(r!.freq) - freqToMidi(f))).toBeLessThan(0.1);
  });

  it('does not report the octave below when the 2nd harmonic is strong', () => {
    const b = new Float32Array(2048);
    for (let i = 0; i < b.length; i++) {
      const p = (2 * Math.PI * 220 * i) / SR;
      b[i] = 0.2 * Math.sin(p) + 0.3 * Math.sin(2 * p);
    }
    expect(Math.round(freqToMidi(detectPitch(b, SR)!.freq))).toBe(57);
  });

  it('returns null for silence and for noise', () => {
    expect(detectPitch(new Float32Array(2048), SR)).toBeNull();
    let seed = 1;
    const noise = Float32Array.from({ length: 2048 }, () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647 - 0.5) * 0.6;
    });
    expect(detectPitch(noise, SR)).toBeNull();
  });

  it('names notes', () => {
    expect(midiName(69)).toBe('A4');
    expect(midiName(60)).toBe('C4');
    expect(midiToFreq(69)).toBe(440);
  });
});

const US = `#TITLE:Test
#ARTIST:Me
#BPM:120
#GAP:1000
: 0 4 0 Hel
: 4 4 2 lo
- 10
* 16 8 4 world
F 24 4 0 ~
E
: 99 4 0 ignored
`;

describe('UltraStar charts', () => {
  const c = parseUltraStar(US);
  it('reads header and note timing', () => {
    expect(c.title).toBe('Test');
    expect(c.notes).toHaveLength(4);
    // 120 BPM => a beat unit is 60/(120*4) = 0.125 s, plus 1 s gap
    expect(c.notes[0]).toMatchObject({ start: 1, end: 1.5, midi: 60, kind: 'normal', line: 0 });
    expect(c.notes[1]).toMatchObject({ start: 1.5, midi: 62 });
    expect(c.notes[2]).toMatchObject({ start: 3, end: 4, midi: 64, kind: 'golden', line: 1 });
    expect(c.notes[3].kind).toBe('free');
  });
  it('builds lyric lines', () => {
    expect(c.lines.map((l) => l.text)).toEqual(['Hello', 'world~']);
    expect(lineAt(c.lines, 0)).toBe(0);
    expect(lineAt(c.lines, 2.5)).toBe(1);
    expect(lineAt(c.lines, 99)).toBe(-1);
  });
  it('finds notes by time', () => {
    expect(noteAt(c.notes, 1.2)).toBe(0);
    expect(noteAt(c.notes, 2.5)).toBe(-1);
    expect(noteAt(c.notes, 3.5)).toBe(2);
    expect(nearestNote(c.notes, 2.1)!.midi).toBe(62);
    expect(nearestNote(c.notes, 2.9)!.midi).toBe(64);
  });
  it('accepts a decimal comma in BPM and rejects files without notes', () => {
    expect(parseUltraStar('#BPM:300,5\n: 0 2 0 a\n').notes).toHaveLength(1);
    expect(() => parseUltraStar('#BPM:120\n')).toThrow();
    expect(() => parseUltraStar(': 0 2 0 a\n')).toThrow();
  });
});

describe('LRC lyrics', () => {
  it('parses stamps, repeats and tags', () => {
    const c = parseLrc('[ti:Song]\n[00:12.50]first\n[00:20.00][01:00.00]again\n[00:30.00]\n');
    expect(c.title).toBe('Song');
    expect(c.hasPitch).toBe(false);
    expect(c.lines.map((l) => [l.start, l.text])).toEqual([
      [12.5, 'first'],
      [20, 'again'],
      [60, 'again'],
    ]);
    expect(c.lines[0].end).toBe(20);
  });
  it('detects formats', () => {
    expect(detectKind(US)).toBe('ultrastar');
    expect(detectKind('[00:01.00]hi')).toBe('lrc');
    expect(detectKind('just some text')).toBeNull();
  });
});

describe('scoring', () => {
  it('folds octaves', () => {
    expect(foldDiff(48, 60)).toBe(0);
    expect(foldDiff(61, 60)).toBe(1);
    expect(foldDiff(71, 60)).toBe(-1);
    expect(foldDiff(66, 60)).toBe(6);
  });

  const sing = (s: GuideScorer, pitch: (midi: number) => number | null) => {
    const c = demoChart();
    const dt = 1 / 60;
    for (let t = 0; t < 30; t += dt) {
      const i = noteAt(c.notes, t);
      s.push(t, i >= 0 ? pitch(c.notes[i].midi) : null, dt);
    }
    return s.result();
  };

  it('gives full marks for the right notes, in any octave', () => {
    expect(sing(new GuideScorer(demoChart(), 'normal'), (m) => m).score).toBeGreaterThan(99);
    expect(sing(new GuideScorer(demoChart(), 'normal'), (m) => m - 12).score).toBeGreaterThan(99);
  });
  it('gives nothing for wrong notes or silence', () => {
    expect(sing(new GuideScorer(demoChart(), 'normal'), (m) => m + 4).score).toBe(0);
    const silent = sing(new GuideScorer(demoChart(), 'normal'), () => null);
    expect(silent.score).toBe(0);
    expect(silent.voicedSec).toBe(0);
  });
  it('is stricter on hard than on easy', () => {
    const off = (m: number) => m + 1.5;
    expect(sing(new GuideScorer(demoChart(), 'easy'), off).score).toBeGreaterThan(99);
    expect(sing(new GuideScorer(demoChart(), 'hard'), off).score).toBe(0);
  });
  it('follows a key change', () => {
    const s = new GuideScorer(demoChart(), 'hard');
    s.transpose = 3;
    expect(sing(s, (m) => m + 3).score).toBeGreaterThan(99);
  });

  it('free mode rewards steady singing over wobble, and silence scores zero', () => {
    const run = (pitch: (t: number) => number | null) => {
      const s = new FreeScorer();
      for (let t = 0; t < 20; t += 1 / 60) s.push(t, pitch(t), 1 / 60);
      return s.result().score;
    };
    const steady = run((t) => 60 + (Math.floor(t / 2) % 5) * 2);
    const wobbly = run((t) => 60.5 + 3 * Math.sin(t * 40));
    // (without a melody to compare with, free scoring never reaches the top grades: 79 at most)
    expect(steady).toBeGreaterThan(70);
    expect(steady).toBeLessThanOrEqual(79);
    // one held note is steady and long, but it is not a song
    expect(run(() => 65)).toBeLessThan(65);
    expect(wobbly).toBeLessThan(steady - 25);
    expect(run(() => null)).toBe(0);
  });

  it('grades', () => {
    expect(gradeOf(96)).toBe('SSS');
    expect(gradeOf(76)).toBe('A');
    expect(gradeOf(10)).toBe('D');
  });
});

describe('YouTube links', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abcdefghijk&t=10s', 'abcdefghijk'],
    ['youtu.be/abcdefghijk?si=x', 'abcdefghijk'],
    ['https://m.youtube.com/shorts/abc_efg-ijk', 'abc_efg-ijk'],
    ['https://www.youtube.com/embed/abcdefghijk', 'abcdefghijk'],
    ['https://music.youtube.com/watch?v=abcdefghijk', 'abcdefghijk'],
    ['abcdefghijk', 'abcdefghijk'],
  ])('%s', (url, id) => expect(parseVideoId(url)).toBe(id));
  it.each(['', 'hello world', 'https://example.com/watch?v=abcdefghijk', 'https://youtube.com/watch?v=short'])(
    'rejects %s',
    (url) => expect(parseVideoId(url)).toBeNull(),
  );
});
