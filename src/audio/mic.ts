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
    src.connect(an); // not connected to the speakers: no feedback
    this.analyser = an;
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
