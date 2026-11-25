import type { Chart, Note } from './chart';
import { midiToFreq } from '../audio/pitch';

/** Whatever plays the song: a YouTube player, or the built-in synth for the warm-up. */
export interface Transport {
  time(): number;
  duration(): number;
  playing(): boolean;
  ended(): boolean;
  play(): void;
  pause(): void;
  seek(t: number): void;
  destroy(): void;
}

// ---------- YouTube ----------

export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
    id = m ? m[1] : u.searchParams.get('v');
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

let apiReady: Promise<any> | null = null;
function loadYouTubeApi(): Promise<any> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve, reject) => {
    const w = window as any;
    if (w.YT?.Player) return resolve(w.YT);
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => {
      apiReady = null;
      reject(new Error('youtube_api'));
    };
    document.head.appendChild(tag);
  });
  return apiReady;
}

export interface YouTubeEvents {
  onReady?(): void;
  onTitle?(title: string): void;
  /** 2 bad id, 5 player error, 100 removed/private, 101/150 embedding disabled, -1 API did not load */
  onError?(code: number): void;
}

/** The video plays in YouTube's own embedded player; we only read its clock. */
export class YouTubeTransport implements Transport {
  private player: any = null;
  private state = -1;
  private dead = false;
  private lastT = 0;
  private lastAt = 0;

  constructor(host: HTMLElement, videoId: string, ev: YouTubeEvents = {}) {
    const el = document.createElement('div');
    host.appendChild(el);
    loadYouTubeApi()
      .then((YT) => {
        if (this.dead) return;
        this.player = new YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => ev.onReady?.(),
            onStateChange: (e: any) => {
              this.state = e.data;
              const title = this.player?.getVideoData?.()?.title;
              if (title) ev.onTitle?.(title);
            },
            onError: (e: any) => ev.onError?.(e.data),
          },
        });
      })
      .catch(() => ev.onError?.(-1));
  }

  /** The player reports its clock in coarse steps; fill in between them so the lane scrolls smoothly. */
  time(): number {
    const raw = this.player?.getCurrentTime?.();
    if (typeof raw !== 'number') return 0;
    const now = performance.now();
    if (raw !== this.lastT) {
      this.lastT = raw;
      this.lastAt = now;
      return raw;
    }
    if (!this.playing()) return raw;
    const rate = this.player.getPlaybackRate?.() ?? 1;
    return raw + Math.min(0.5, (now - this.lastAt) / 1000) * rate;
  }
  duration() {
    return this.player?.getDuration?.() ?? 0;
  }
  playing() {
    return this.state === 1;
  }
  ended() {
    return this.state === 0;
  }
  play() {
    this.player?.playVideo?.();
  }
  pause() {
    this.player?.pauseVideo?.();
  }
  seek(t: number) {
    this.player?.seekTo?.(t, true);
  }
  destroy() {
    this.dead = true;
    try {
      this.player?.destroy?.();
    } catch {
      /* already gone */
    }
    this.player = null;
  }
}

// ---------- built-in warm-up ----------

const SOLFEGE = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'Fa', 'Mi', 'Re', 'Do'];
const STEPS = [0, 2, 4, 5, 7, 5, 4, 2, 0];
const ROOTS = [57, 59, 60, 62]; // A3, B3, C4, D4: each round a little higher

/** An original scale exercise, so scoring can be tried with no video and no chart file. */
export function demoChart(): Chart {
  const notes: Note[] = [];
  let t = 2;
  ROOTS.forEach((root, line) => {
    STEPS.forEach((step, i) => {
      const len = i === STEPS.length - 1 ? 1 : 0.5;
      notes.push({
        start: t,
        end: t + len - 0.04,
        midi: root + step,
        text: (i ? ' ' : '') + SOLFEGE[i],
        kind: i === STEPS.length - 1 ? 'golden' : 'normal',
        line,
      });
      t += len;
    });
    t += 1;
  });
  const lines = ROOTS.map((_, line) => {
    const ns = notes.filter((n) => n.line === line);
    return {
      start: ns[0].start,
      end: ns[ns.length - 1].end,
      text: ns.map((n) => n.text).join('').trim(),
      parts: ns.map((n) => ({ start: n.start, end: n.end, text: n.text })),
    };
  });
  return { notes, lines, hasPitch: true };
}

/** Plays a chart's melody as soft tones through Web Audio. */
export class SynthTransport implements Transport {
  private ctx: AudioContext | null = null;
  private t0 = 0;
  private len: number;

  constructor(
    private chart: Chart,
    private volume: () => number,
  ) {
    this.len = (chart.notes[chart.notes.length - 1]?.end ?? 0) + 1.5;
  }

  private begin() {
    const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx = (this.ctx = new Ctx());
    this.t0 = ctx.currentTime + 0.1;
    const out = ctx.createGain();
    out.gain.value = this.volume();
    out.connect(ctx.destination);
    for (const n of this.chart.notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(n.midi);
      const a = this.t0 + n.start;
      const b = this.t0 + n.end;
      g.gain.setValueAtTime(0, a);
      g.gain.linearRampToValueAtTime(0.5, a + 0.02);
      g.gain.setValueAtTime(0.5, b - 0.04);
      g.gain.linearRampToValueAtTime(0, b);
      osc.connect(g).connect(out);
      osc.start(a);
      osc.stop(b + 0.01);
    }
  }

  time() {
    return this.ctx ? Math.max(0, this.ctx.currentTime - this.t0) : 0;
  }
  duration() {
    return this.len;
  }
  playing() {
    return !!this.ctx && this.ctx.state === 'running' && !this.ended();
  }
  ended() {
    return !!this.ctx && this.ctx.currentTime - this.t0 >= this.len;
  }
  play() {
    if (!this.ctx) this.begin();
    else void this.ctx.resume();
  }
  pause() {
    void this.ctx?.suspend();
  }
  seek() {
    /* the warm-up is 30 seconds; it restarts instead of seeking */
  }
  destroy() {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
