// The engine: turns the lead player's audio into backing track + guide vocal, ahead of the visible
// (muted) player, and plays it in time with that player. Runs only on this computer; nothing is stored.
import * as ort from 'onnxruntime-web/webgpu';
import { MODELS, _Spectral, type MdxConfig } from '../../src/separate/mdx';
import { decode16, type PageMsg, type TapBlock } from './protocol';

const RATE = 44100;
const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
const instGain = ctx.createGain();
const vocGain = ctx.createGain();
instGain.connect(ctx.destination);
vocGain.connect(ctx.destination);
vocGain.gain.value = 0;

type Seg = { t: number; inst: Float32Array[]; voc: Float32Array[]; src?: AudioBufferSourceNode[] };

const S = {
  running: false,
  mode: 'auto' as 'auto' | 'ai' | 'classic',
  using: 'classic' as 'ai' | 'classic',
  cfg: null as (MdxConfig & { file: string }) | null,
  session: null as ort.InferenceSession | null,
  sp: null as _Spectral | null,
  // input from the lead player
  t0: 0,
  L: new Float32Array(0),
  R: new Float32Array(0),
  len: 0,
  done: 0, // samples already turned into output
  // output
  segs: [] as Seg[],
  clock: { t: 0, at: 0, playing: false },
  speed: 0,
  busy: false,
  loadingModel: false,
};

const toPage = (msg: unknown) => chrome.runtime.sendMessage({ to: 'page', msg }).catch(() => {});

function reset(t: number) {
  S.t0 = t;
  S.len = 0;
  S.done = 0;
  for (const s of S.segs) s.src?.forEach((x) => x.stop());
  S.segs = [];
}

function append(t: number, l: Float32Array, r: Float32Array) {
  const expected = S.t0 + S.len / RATE;
  if (S.len === 0 || Math.abs(t - expected) > 0.25) reset(t); // first block, seek, or an ad
  if (S.len + l.length > S.L.length) {
    const n = Math.max(S.L.length * 2, S.len + l.length + RATE * 30);
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    L.set(S.L.subarray(0, S.len));
    R.set(S.R.subarray(0, S.len));
    S.L = L;
    S.R = R;
  }
  S.L.set(l, S.len);
  S.R.set(r, S.len);
  S.len += l.length;
}

/** Classic karaoke: keep the sides and the bass, cancel what sits in the centre (the lead vocal). */
function classic(l: Float32Array, r: Float32Array) {
  const n = l.length;
  const inst = [new Float32Array(n), new Float32Array(n)];
  const voc = [new Float32Array(n), new Float32Array(n)];
  let lp = 0;
  const a = Math.exp((-2 * Math.PI * 140) / RATE); // keep bass below ~140 Hz from the mid
  for (let i = 0; i < n; i++) {
    const mid = (l[i] + r[i]) / 2;
    const side = (l[i] - r[i]) / 2;
    lp = a * lp + (1 - a) * mid;
    inst[0][i] = side + lp;
    inst[1][i] = -side + lp;
    voc[0][i] = l[i] - inst[0][i];
    voc[1][i] = r[i] - inst[1][i];
  }
  return { inst, voc };
}

async function loadModel(url: string, base: string, key: string) {
  void base;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/'); // bundled with the extension
  // extension pages are cross-origin isolated (manifest), so the CPU fallback can use several threads
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 2) : 1;
  (ort.env.webgpu as any).powerPreference = 'high-performance';
  let res = await fetch(url);
  let bytes: ArrayBuffer;
  if (res.ok) bytes = await res.arrayBuffer();
  else {
    const man = await (await fetch(url + '.parts.json')).json();
    const buf = new Uint8Array(man.size);
    let o = 0;
    for (let i = 0; i < man.parts; i++) {
      const b = new Uint8Array(await (await fetch(`${url}.part${i}`)).arrayBuffer());
      buf.set(b, o);
      o += b.length;
    }
    bytes = buf.buffer;
  }
  const eps = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  for (const ep of eps) {
    try {
      S.session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [ep] });
      break;
    } catch {
      /* next */
    }
  }
  S.cfg = MODELS[key];
  S.sp = new _Spectral(S.cfg);
}

/** Process as much of the buffered input as possible. */
async function work() {
  if (S.busy || !S.running) return;
  S.busy = true;
  try {
    for (;;) {
      if (S.using === 'classic') {
        const n = S.len - S.done;
        if (n < 2048) break;
        const { inst, voc } = classic(S.L.subarray(S.done, S.len), S.R.subarray(S.done, S.len));
        S.segs.push({ t: S.t0 + S.done / RATE, inst, voc });
        S.done = S.len;
        break;
      }
      // AI: windows of `chunk` samples, keeping `trim` samples of context on each side
      const cfg = S.cfg!;
      const sp = S.sp!;
      const chunk = sp.chunk;
      const trim = cfg.nFft / 2;
      const gen = chunk - 2 * trim;
      if (S.len < S.done + gen + trim) break;
      const a = S.done - trim;
      const win = (X: Float32Array) => {
        const w = new Float32Array(chunk);
        for (let i = 0; i < chunk; i++) {
          const j = a + i;
          w[i] = j >= 0 && j < S.len ? X[j] : 0;
        }
        return w;
      };
      const wl = win(S.L);
      const wr = win(S.R);
      const spec = new Float32Array(4 * cfg.dimF * cfg.dimT);
      const t1 = performance.now();
      sp.stft([wl, wr], spec);
      const out = await S.session!.run({ [S.session!.inputNames[0]]: new ort.Tensor('float32', spec, [1, 4, cfg.dimF, cfg.dimT]) });
      const [yl, yr] = sp.istft(out[S.session!.outputNames[0]].data as Float32Array);
      const secs = (performance.now() - t1) / 1000;
      S.speed = gen / RATE / secs;
      const prim = [yl.subarray(trim, trim + gen), yr.subarray(trim, trim + gen)].map((c) => c.map((v) => v * cfg.compensate));
      const mix = [wl.subarray(trim, trim + gen), wr.subarray(trim, trim + gen)];
      const other = mix.map((m, c) => m.map((v, i) => v - prim[c][i]));
      const inst = cfg.primary === 'instrumental' ? prim : other;
      const voc = cfg.primary === 'instrumental' ? other : prim;
      S.segs.push({ t: S.t0 + S.done / RATE, inst, voc });
      S.done += gen;
      if (S.mode === 'auto' && S.speed < 1.05) {
        S.using = 'classic'; // this computer cannot keep up: fall back
        toPage({ type: 'status', state: 'fallback', mode: 'classic', speed: S.speed });
      }
    }
  } catch (e: any) {
    toPage({ type: 'status', state: 'error', message: String(e?.message ?? e) });
  } finally {
    S.busy = false;
  }
}

/** Where the visible player is now (media time). */
const nowMedia = () => S.clock.t + (S.clock.playing ? (performance.now() - S.clock.at) / 1000 : 0);

function schedule() {
  if (!S.running || !S.clock.playing) return;
  const m = nowMedia();
  for (const s of S.segs) {
    if (s.src) continue;
    const dur = s.inst[0].length / RATE;
    if (s.t + dur < m) continue; // too late
    const off = Math.max(0, m - s.t);
    const when = ctx.currentTime + Math.max(0, s.t - m) - (ctx.outputLatency || 0);
    const mk = (chs: Float32Array[], g: GainNode) => {
      const b = ctx.createBuffer(2, chs[0].length, RATE);
      b.copyToChannel(chs[0] as Float32Array<ArrayBuffer>, 0);
      b.copyToChannel(chs[1] as Float32Array<ArrayBuffer>, 1);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(g);
      src.start(Math.max(ctx.currentTime, when), off);
      return src;
    };
    s.src = [mk(s.inst, instGain), mk(s.voc, vocGain)];
  }
  // forget what has been played
  S.segs = S.segs.filter((s) => s.t + s.inst[0].length / RATE > m - 2);
}

function unschedule() {
  for (const s of S.segs) {
    s.src?.forEach((x) => {
      try {
        x.stop();
      } catch {
        /* not started */
      }
    });
    s.src = undefined;
  }
}

setInterval(() => {
  schedule();
  if (S.running) {
    const ahead = S.t0 + S.done / RATE - nowMedia();
    // the AI is about to fall behind the picture: switch to classic so the backing never stops
    if (S.using === 'ai' && S.mode === 'auto' && S.clock.playing && ahead < 1) {
      S.using = 'classic';
      toPage({ type: 'status', state: 'fallback', mode: 'classic', speed: S.speed, message: 'too slow for the AI model' });
    }
    toPage({ type: 'status', state: S.loadingModel ? 'loading' : 'running', mode: S.using, speed: S.speed, buffered: ahead });
  }
}, 250);

chrome.runtime.onMessage.addListener((m: any) => {
  if (m?.to !== 'engine') return;
  const msg = m.msg as PageMsg | TapBlock;
  if (msg.type === 'tap') {
    if (!S.running) return;
    append(msg.t, decode16(msg.l), decode16(msg.r));
    void work();
  } else if (msg.type === 'start') {
    S.running = true;
    S.mode = msg.mode;
    vocGain.gain.value = msg.vocal;
    void ctx.resume();
    reset(0);
    if (msg.mode === 'classic') S.using = 'classic';
    else {
      S.using = 'classic'; // until the model is ready
      toPage({ type: 'status', state: 'loading' });
      S.loadingModel = true;
      loadModel(msg.modelUrl, msg.ortBase, msg.model)
        .finally(() => (S.loadingModel = false))
        .then(() => {
          S.using = 'ai';
          S.done = Math.max(0, S.len - (S.cfg!.nFft / 2)); // continue from here with the model
        })
        .catch((e) => toPage({ type: 'status', state: 'fallback', mode: 'classic', message: String(e?.message ?? e) }));
    }
  } else if (msg.type === 'clock') {
    const jumped = Math.abs(msg.t - nowMedia()) > 0.5;
    if (jumped || msg.playing !== S.clock.playing) unschedule();
    S.clock = { t: msg.t, at: performance.now(), playing: msg.playing };
  } else if (msg.type === 'vocal') {
    vocGain.gain.setTargetAtTime(msg.level, ctx.currentTime, 0.03);
  } else if (msg.type === 'stop') {
    S.running = false;
    unschedule();
    reset(0);
  }
});
