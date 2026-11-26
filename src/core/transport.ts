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
  /** Picture only: the sound comes from our own tracks. */
  muted?: boolean;
  onReady?(): void;
  onTitle?(title: string): void;
  /** 2 bad id, 5 player error, 100 removed/private, 101/150 embedding disabled, -1 API did not load */
  onError?(code: number): void;
}

/** The video plays in YouTube's own embedded player; we only read its clock. */
/** Dev only (?fakeyt): a local video in a cross-origin frame stands in for the YouTube player. */
const FAKE_YT = typeof location !== 'undefined' && /[?&]fakeyt\b/.test(location.search);
let fakeId = 0;

export class YouTubeTransport implements Transport {
  private player: any = null;
  private state = -1;
  private dead = false;
  private lastT = 0;
  private lastAt = 0;

  constructor(host: HTMLElement, videoId: string, ev: YouTubeEvents = {}) {
    if (FAKE_YT) {
      this.fake(host, ev);
      return;
    }
    const el = document.createElement('div');
    host.appendChild(el);
    loadYouTubeApi()
      .then((YT) => {
        if (this.dead) return;
        this.player = new YT.Player(el, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: ev.muted
            ? { playsinline: 1, rel: 0, modestbranding: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3 }
            : { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: () => {
              if (ev.muted) this.player?.mute?.();
              ev.onReady?.();
            },
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

  private fake(host: HTMLElement, ev: YouTubeEvents) {
    const id = String(++fakeId);
    const f = document.createElement('iframe');
    f.src = `http://127.0.0.1:4174/exttest-embed.html?muted=${ev.muted ? 1 : 0}&id=${id}`;
    f.allow = 'autoplay';
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
    host.appendChild(f);
    let t = 0;
    let playing = false;
    let ended = false;
    let dur = 0;
    const send = (m: object) => f.contentWindow?.postMessage(m, '*');
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow || !e.data || e.data.id !== id) return;
      ({ t, playing, ended, dur } = e.data);
      this.state = ended ? 0 : playing ? 1 : 2;
    });
    this.player = {
      getCurrentTime: () => t,
      getDuration: () => dur,
      getPlaybackRate: () => 1,
      playVideo: () => send({ cmd: 'play' }),
      pauseVideo: () => send({ cmd: 'pause' }),
      seekTo: (s: number) => send({ cmd: 'seek', t: s }),
      mute: () => send({ cmd: 'mute', on: true }),
      unMute: () => send({ cmd: 'mute', on: false }),
      destroy: () => f.remove(),
      getVideoData: () => ({ title: 'Test clip' }),
    };
    setTimeout(() => ev.onReady?.(), 300);
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
  setMuted(m: boolean) {
    if (m) this.player?.mute?.();
    else this.player?.unMute?.();
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

// ---------- your own song, separated in the browser ----------

/** Plays the backing track and the original vocal as two layers, so the vocal can be faded in and out. */
export class LocalTransport implements Transport {
  private ctx: AudioContext;
  private inst: AudioBuffer;
  private voc: AudioBuffer;
  private instGain: GainNode;
  private vocGain: GainNode;
  private srcs: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx time when position 0 would have played
  private pos = 0; // position while paused
  private isPlaying = false;
  private done = false;

  constructor(
    inst: Float32Array[],
    voc: Float32Array[],
    vocalLevel: number,
    private rate = 44100,
  ) {
    const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.inst = this.buffer(inst);
    this.voc = this.buffer(voc);
    this.instGain = this.ctx.createGain();
    this.vocGain = this.ctx.createGain();
    this.vocGain.gain.value = vocalLevel;
    this.instGain.connect(this.ctx.destination);
    this.vocGain.connect(this.ctx.destination);
  }

  private buffer(chs: Float32Array[]): AudioBuffer {
    const b = this.ctx.createBuffer(chs.length, chs[0].length, this.rate);
    chs.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    return b;
  }

  /** Swap in new tracks (after a key change) without losing the position. */
  replace(inst: Float32Array[], voc: Float32Array[]) {
    const was = this.isPlaying;
    const t = this.time();
    this.stopSources();
    this.inst = this.buffer(inst);
    this.voc = this.buffer(voc);
    this.pos = t;
    if (was) this.startAt(t);
  }

  setVocal(level: number) {
    this.vocGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.03);
  }

  private stopSources() {
    for (const s of this.srcs) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.srcs = [];
    this.isPlaying = false;
  }

  private startAt(t: number) {
    void this.ctx.resume();
    const when = this.ctx.currentTime + 0.05;
    const mk = (buf: AudioBuffer, g: GainNode) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(g);
      s.start(when, Math.max(0, t));
      return s;
    };
    const a = mk(this.inst, this.instGain);
    const b = mk(this.voc, this.vocGain);
    a.onended = () => {
      if (this.isPlaying && this.time() >= this.duration() - 0.1) {
        this.isPlaying = false;
        this.done = true;
      }
    };
    this.srcs = [a, b];
    this.startedAt = when - t;
    this.isPlaying = true;
    this.done = false;
  }

  time() {
    return this.isPlaying ? Math.min(this.duration(), Math.max(0, this.ctx.currentTime - this.startedAt)) : this.pos;
  }
  duration() {
    return this.inst.duration;
  }
  playing() {
    return this.isPlaying && this.ctx.currentTime >= this.startedAt;
  }
  ended() {
    return this.done;
  }
  play() {
    if (this.isPlaying) return;
    this.startAt(this.done ? 0 : this.pos);
  }
  pause() {
    if (!this.isPlaying) return;
    this.pos = this.time();
    this.stopSources();
  }
  seek(t: number) {
    const was = this.isPlaying;
    this.stopSources();
    this.pos = Math.max(0, Math.min(t, this.duration()));
    this.done = false;
    if (was) this.startAt(this.pos);
  }
  destroy() {
    this.stopSources();
    void this.ctx.close().catch(() => {});
  }
}

/** UltraStar text for a chart made from your own song, so the guide can be shared or re-imported. */
export function toUltraStar(title: string, notes: Note[]): string {
  const bpm = 300; // 4 beats per 0.2 s: fine enough for sung notes
  const beat = 60 / (bpm * 4);
  const rows = [`#TITLE:${title}`, '#ARTIST:', `#BPM:${bpm}`, '#GAP:0'];
  let line = notes[0]?.line ?? 0;
  for (const n of notes) {
    const b0 = Math.round(n.start / beat);
    if (n.line !== line) {
      rows.push(`- ${b0}`);
      line = n.line;
    }
    const len = Math.max(1, Math.round((n.end - n.start) / beat));
    rows.push(`: ${b0} ${len} ${n.midi - 60} ${n.text || '~'}`);
  }
  rows.push('E');
  return rows.join('\n') + '\n';
}

/**
 * Two YouTube players of the same MV: the small "lead" player runs LEAD seconds ahead and its sound
 * goes to the URKTV extension (which turns it into the backing track on this computer); the big main
 * player is muted and is the clock everything follows.
 */
export class DualTransport implements Transport {
  constructor(
    readonly main: YouTubeTransport,
    readonly lead: YouTubeTransport,
    /** How far the lead runs in front: 9 s for the AI, about 2 s for the classic vocal cut. */
    public ahead: number,
  ) {}
  private timer = 0;
  time() {
    return this.main.time();
  }
  duration() {
    return this.main.duration();
  }
  playing() {
    return this.main.playing();
  }
  ended() {
    return this.main.ended();
  }
  private waiting: 'main' | 'lead' | null = null;
  /** The picture has started at least once (before that, only the lead runs: nothing to keep in step). */
  started = false;
  /**
   * First start: the lead player starts now; the picture starts once the lead is really `ahead`
   * seconds in (YouTube buffers, so a fixed timer would leave the AI without its head start).
   */
  startStaggered(onMainStart?: () => void, ready?: () => boolean) {
    this.lead.play();
    window.clearInterval(this.timer);
    const t0 = performance.now();
    this.timer = window.setInterval(() => {
      // a lead that already reached the end has given the extension everything: start
      const ok = (ready ? ready() : this.lead.time() >= this.ahead) || this.lead.ended();
      // never hold the picture forever (a lead that cannot get going, an ad...)
      if (ok || performance.now() - t0 > 10 * 60 * 1000) {
        window.clearInterval(this.timer);
        this.started = true;
        this.main.play();
        onMainStart?.();
      }
    }, 200);
  }
  play() {
    this.waiting = null;
    this.started = true;
    window.clearInterval(this.timer);
    if (!this.solo) this.lead.play();
    this.main.play();
  }
  pause() {
    window.clearInterval(this.timer);
    this.waiting = null;
    this.lead.pause();
    this.main.pause();
  }
  /**
   * Jump: both players go to t; the lead plays from there and the picture waits until the lead is
   * `ahead` seconds in again (the AI needs that audio before the picture gets there).
   */
  seek(t: number) {
    t = Math.max(0, t);
    if (this.solo) return this.main.seek(t);
    // inside what the lead has already played (and the extension already turned into backing):
    // just move the picture, the backing follows at once
    if (t >= this.main.time() && t <= this.lead.time() - 1) {
      this.main.seek(t);
      return;
    }
    this.main.pause();
    this.main.seek(t);
    this.lead.seek(t);
    this.lead.play();
    this.waiting = 'main';
  }
  /** The backing track never arrived: drop the lead and let the MV play with its own sound. */
  solo = false;
  fallbackToOriginal() {
    this.solo = true;
    this.started = true;
    this.waiting = null;
    window.clearInterval(this.timer);
    this.lead.pause();
    this.main.setMuted(false);
    this.main.play();
  }
  /**
   * Keep the lead in front without seeking it (every seek throws away the AI's work): if the lead
   * falls behind (buffering), the picture waits for it; if the picture falls behind, the lead waits.
   */
  keepAhead() {
    if (this.solo || !this.started) return;
    const gap = this.lead.time() - this.main.time();
    if (this.waiting === 'main') {
      if (gap >= this.ahead - 0.3) {
        this.waiting = null;
        this.main.play();
      }
      return;
    }
    if (this.waiting === 'lead') {
      if (gap <= this.ahead + 0.3) {
        this.waiting = null;
        this.lead.play();
      }
      return;
    }
    // judged on the clocks, not on "playing": during an ad or buffering a player can report
    // playing while its time stands still, and the other one runs away
    if (gap > this.ahead + 3 && this.lead.playing()) {
      this.waiting = 'lead';
      this.lead.pause();
    } else if (gap < this.ahead - 3 && this.main.playing() && !this.lead.ended()) {
      this.waiting = 'main';
      this.main.pause();
    }
  }
  /** The backing ran out: the picture waits, the lead keeps feeding the extension. */
  holdForBacking() {
    this.waiting = null;
    this.main.pause();
    if (!this.lead.ended()) this.lead.play();
  }
  /** True while one player waits for the other (shown as "buffering"). */
  syncing() {
    return this.waiting !== null;
  }
  destroy() {
    window.clearInterval(this.timer);
    this.lead.destroy();
    this.main.destroy();
  }
}
