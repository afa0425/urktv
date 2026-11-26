import { detectPitch, freqToMidi, rms } from './pitch';

export interface MicFrame {
  /** Fractional MIDI note of the voice, or null when no clear pitch. */
  midi: number | null;
  /** 0..1 input level, for the meter. */
  level: number;
}

const FFT = 2048;
const MIN_INTERVAL_MS = 22;

/** Microphone -> pitch. Audio never leaves the browser. */
export class MicPitch {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(FFT);
  private last: MicFrame = { midi: null, level: 0 };
  private lastAt = 0;
  private recent: (number | null)[] = [];
  // hearing yourself: dry voice + a short echo, to the speakers/headphones
  private monGain: GainNode | null = null;
  private echoWet: GainNode | null = null;
  private monitor = { on: false, level: 0.8, echo: 0.3 };
  private loud = 0;
  private howlPitch = -99;
  /** Set when feedback (howling) was detected and the monitor switched itself off. */
  howl = false;

  get running() {
    return !!this.analyser;
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();
    // The browser's voice processing is made for calls; it mangles sung pitch, so turn it off.
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = FFT;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    this.analyser = an;

    // monitor chain: voice -> gain -> out, voice -> delay(feedback) -> lowpass -> wet -> out
    const ctx = this.ctx;
    const mon = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.12;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3800;
    const wet = ctx.createGain();
    src.connect(mon);
    mon.connect(ctx.destination);
    mon.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(ctx.destination);
    this.monGain = mon;
    this.echoWet = wet;
    this.howl = false;
    this.applyMonitor();
  }

  /** How you hear yourself. Off by default in the browser; the stage turns it on from settings. */
  setMonitor(on: boolean, level: number, echo: number): void {
    this.monitor = { on, level, echo };
    if (on) this.howl = false;
    this.applyMonitor();
  }

  /** What the browser reports as the extra delay of the output (seconds), for the hint. */
  outputLatency(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    return c ? (c.baseLatency || 0) + (c.outputLatency || 0) : 0;
  }

  private applyMonitor() {
    if (!this.monGain || !this.echoWet || !this.ctx) return;
    const t = this.ctx.currentTime;
    const on = this.monitor.on && !this.howl;
    this.monGain.gain.setTargetAtTime(on ? this.monitor.level : 0, t, 0.02);
    this.echoWet.gain.setTargetAtTime(on ? this.monitor.echo * 0.9 : 0, t, 0.02);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.recent = [];
    this.last = { midi: null, level: 0 };
  }

  /** Cheap to call every animation frame; analysis is throttled internally. */
  read(now = performance.now()): MicFrame {
    if (!this.analyser || !this.ctx) return this.last;
    if (now - this.lastAt < MIN_INTERVAL_MS) return this.last;
    this.lastAt = now;
    this.analyser.getFloatTimeDomainData(this.buf);
    const level = Math.min(1, rms(this.buf) * 6);

    const p = detectPitch(this.buf, this.ctx.sampleRate);
    const raw = p ? freqToMidi(p.freq) : null;

    // feedback guard: howling is one pitch at full level that does not let go; singing moves and breathes
    if (this.monitor.on && !this.howl) {
      if (level > 0.9 && raw !== null && Math.abs(raw - this.howlPitch) < 0.3) this.loud++;
      else {
        this.loud = 0;
        this.howlPitch = raw ?? -99;
      }
      if (this.loud * MIN_INTERVAL_MS > 2500) {
        this.howl = true;
        this.loud = 0;
        this.applyMonitor();
      }
    }

    // Median of the last 3 voiced values removes single-frame octave glitches.
    this.recent.push(raw);
    if (this.recent.length > 3) this.recent.shift();
    let midi = raw;
    const voiced = this.recent.filter((v): v is number => v !== null);
    if (raw !== null && voiced.length === 3) {
      midi = [...voiced].sort((a, b) => a - b)[1];
    }
    this.last = { midi, level };
    return this.last;
  }
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}
