// KTV atmosphere sounds, made on the spot with Web Audio (no recordings): applause, cheers,
// laughter, drum roll, boos, air horn.
let ctx: AudioContext | null = null;
const ac = () => (ctx ??= new AudioContext());

function noise(c: AudioContext, secs: number) {
  const b = c.createBuffer(1, Math.ceil(c.sampleRate * secs), c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = b;
  return s;
}

/** Many short filtered noise claps spread over time. */
function claps(c: AudioContext, t0: number, secs: number, rate: number, vol: number) {
  const n = Math.round(secs * rate);
  for (let k = 0; k < n; k++) {
    const t = t0 + Math.random() * secs * (0.6 + 0.4 * (k / n));
    const s = noise(c, 0.05);
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 1600;
    f.Q.value = 1.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol * (0.5 + Math.random() * 0.5), t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    s.connect(f).connect(g).connect(c.destination);
    s.start(t);
  }
}

function tone(c: AudioContext, type: OscillatorType, freqs: [number, number][], t0: number, vol: number, end: number) {
  const o = c.createOscillator();
  o.type = type;
  for (const [t, f] of freqs) o.frequency.linearRampToValueAtTime(f, t0 + t);
  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.03);
  g.gain.setValueAtTime(vol, t0 + end - 0.08);
  g.gain.linearRampToValueAtTime(0, t0 + end);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + end + 0.05);
}

export const SFX = {
  applause: { icon: '👏', label: '拍手' },
  cheer: { icon: '🎉', label: '歡呼' },
  laugh: { icon: '😂', label: '笑聲' },
  drum: { icon: '🥁', label: '鼓聲' },
  boo: { icon: '👎', label: '噓～' },
  horn: { icon: '📯', label: '喇叭' },
} as const;
export type SfxKind = keyof typeof SFX;

export function playSfx(kind: SfxKind) {
  const c = ac();
  void c.resume();
  const t = c.currentTime + 0.02;
  if (kind === 'applause') claps(c, t, 2.4, 70, 0.5);
  else if (kind === 'cheer') {
    claps(c, t, 2.2, 40, 0.35);
    // a crowd "woo": a few voices sliding up
    for (let v = 0; v < 5; v++) {
      const f0 = 280 + Math.random() * 200;
      tone(c, 'sawtooth', [[0, f0], [0.4, f0 * 1.6], [1.4, f0 * 1.3]], t + v * 0.06, 0.025, 1.5);
    }
  } else if (kind === 'laugh') {
    for (let k = 0; k < 7; k++) {
      const f = 330 - k * 12 + Math.random() * 20;
      tone(c, 'triangle', [[0, f], [0.09, f * 0.85]], t + k * 0.16, 0.12, 0.12);
    }
  } else if (kind === 'drum') {
    for (let k = 0; k < 24; k++) {
      const s = noise(c, 0.04);
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      const g = c.createGain();
      const tt = t + k * 0.045;
      g.gain.setValueAtTime(0.15 + (k / 24) * 0.35, tt);
      g.gain.exponentialRampToValueAtTime(0.001, tt + 0.04);
      s.connect(f).connect(g).connect(c.destination);
      s.start(tt);
    }
    tone(c, 'sine', [[0, 120], [0.3, 50]], t + 1.1, 0.6, 0.35); // and the hit
  } else if (kind === 'boo') {
    for (let v = 0; v < 4; v++) tone(c, 'sawtooth', [[0, 140 + v * 7], [1.2, 110 + v * 5]], t, 0.03, 1.3);
  } else if (kind === 'horn') {
    for (const f of [466, 587, 698]) tone(c, 'sawtooth', [[0, f], [0.6, f]], t, 0.06, 0.6);
  }
}
