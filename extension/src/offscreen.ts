// The engine: turns the lead player's audio into backing track + guide vocal, ahead of the visible
// (muted) player, and plays it in time with that player. Runs only on this computer; nothing is stored.
import { detectPitch, freqToMidi } from '../../src/audio/pitch';
import { MODELS, _Spectral, type MdxConfig } from '../../src/separate/mdx';
import { FFT } from '../../src/separate/fft';
import { decode16, type PageMsg, type TapBlock } from './protocol';

const RATE = 44100;
const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
const instGain = ctx.createGain();
const vocGain = ctx.createGain();
// backing and guide vocal go through the key shifter (when it has loaded) to the speakers
const mix = ctx.createGain();
mix.connect(ctx.destination);
instGain.connect(mix);
vocGain.connect(mix);
let shifter: AudioWorkletNode | null = null;
let wantKey = 0;
ctx.audioWorklet
  .addModule(chrome.runtime.getURL('pitch-worklet.js'))
  .then(() => {
    shifter = new AudioWorkletNode(ctx, 'key-shift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    mix.disconnect();
    mix.connect(shifter);
    shifter.connect(ctx.destination);
    setKey(wantKey);
  })
  .catch(() => {
    /* no key change, the rest works */
  });
/** Backing gets the loudness restore only as the voice goes away (with the voice in, it is the song). */
function applyGains() {
  instGain.gain.setTargetAtTime(1 + (S.makeup - 1) * (1 - S.vocal), ctx.currentTime, 0.3);
}
function setKey(semitones: number) {
  wantKey = semitones;
  shifter?.parameters.get('ratio')!.setValueAtTime(Math.pow(2, semitones / 12), ctx.currentTime);
}
vocGain.gain.value = 0;

type Seg = { t: number; inst: Float32Array[]; voc: Float32Array[]; src?: AudioBufferSourceNode[] };

const S = {
  running: false,
  mode: 'auto' as 'auto' | 'ai' | 'lite' | 'classic',
  using: 'classic' as 'ai' | 'lite' | 'classic',
  lite: null as Worker | null, // the light AI (Spleeter 2 stems), in its own worker
  liteLoading: false,
  lf: 0, // light AI: next STFT frame to output
  makeup: 1, // backing loudness restore (1 = none)
  ep: '', // what runs the high-quality model: webgpu or wasm (CPU)
  epTimes: {} as Record<string, number>,
  vocal: 0,
  cfg: null as (MdxConfig & { file: string }) | null,
  session: null as Worker | null, // the AI model, in its own worker
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
  // diagnostics
  blocks: 0,
  lastTap: -1,
  played: 0,
  resets: 0,
  lastError: '',
};

// --- gray bars for any song: the pitch of the separated vocal, sent ahead of the picture ---
const PR = RATE / 2; // pitch runs at half rate (cheaper, plenty for a voice)
const PF = 1024;
const PH = 512;
const P = { buf: new Float32Array(0), t: 0 };
function pitchFeed(t: number, voc: Float32Array[]) {
  const n = voc[0].length >> 1;
  if (!n) return;
  const mono = new Float32Array(n);
  const a = voc[0];
  const b = voc[1] ?? voc[0];
  for (let i = 0; i < n; i++) mono[i] = (a[2 * i] + a[2 * i + 1] + b[2 * i] + b[2 * i + 1]) / 4;
  const end = P.t + P.buf.length / PR;
  if (!P.buf.length || Math.abs(t - end) > 0.05) {
    P.buf = mono;
    P.t = t;
  } else {
    const c = new Float32Array(P.buf.length + n);
    c.set(P.buf);
    c.set(mono, P.buf.length);
    P.buf = c;
  }
  const midi: (number | null)[] = [];
  let pos = 0;
  for (; pos + PF <= P.buf.length; pos += PH) {
    const r = detectPitch(P.buf.subarray(pos, pos + PF), PR, 0.9, 0.006);
    midi.push(r ? Math.round(freqToMidi(r.freq) * 10) / 10 : null);
  }
  if (midi.length) toPage({ type: 'pitch', t: P.t + PF / 2 / PR, hop: PH / PR, midi });
  P.buf = P.buf.slice(pos);
  P.t += pos / PR;
}

const toPage = (msg: unknown) => chrome.runtime.sendMessage({ to: 'page', msg }).catch(() => {});

function reset(t: number) {
  S.resets++;
  aiAbort(false);
  classicReset();
  S.t0 = t;
  S.len = 0;
  S.done = 0;
  S.lf = 0;
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

/**
 * Classic karaoke, done per frequency (better than plain L-R): in every time-frequency cell, sound
 * that is identical in both channels (the lead vocal sits in the centre) is removed, but only in the
 * voice band, so bass, kick and cymbals stay. Streaming STFT, 2048-point, 75 % overlap.
 */
const CN = 2048;
const CH = 512;
const cWin = new Float64Array(CN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / CN));
const cFft = new FFT(CN);
const C = {
  inL: new Float32Array(CN), // the last CN samples, for the frame that straddles blocks
  inR: new Float32Array(CN),
  fill: 0, // samples in inL/inR not yet framed (counted from the end of the history)
  olaL: new Float64Array(CN * 2),
  olaR: new Float64Array(CN * 2),
  olaV: [new Float64Array(CN * 2), new Float64Array(CN * 2)],
};
const LOW = Math.round((150 / RATE) * CN);
const HIGH = Math.round((7000 / RATE) * CN);

function classicReset() {
  C.inL.fill(0);
  C.inR.fill(0);
  C.fill = 0;
  C.olaL.fill(0);
  C.olaR.fill(0);
  C.olaV.forEach((a) => a.fill(0));
}

function classic(l: Float32Array, r: Float32Array) {
  const outL: number[] = [];
  const outR: number[] = [];
  const vL: number[] = [];
  const vR: number[] = [];
  const re = [new Float64Array(CN), new Float64Array(CN)];
  const im = [new Float64Array(CN), new Float64Array(CN)];
  for (let i = 0; i < l.length; ) {
    // shift up to one hop of samples into the history at once
    const take = Math.min(CH - C.fill, l.length - i);
    C.inL.copyWithin(0, take);
    C.inR.copyWithin(0, take);
    C.inL.set(l.subarray(i, i + take), CN - take);
    C.inR.set(r.subarray(i, i + take), CN - take);
    i += take;
    C.fill += take;
    if (C.fill < CH) continue;
    C.fill = 0;
    // one frame
    for (let k = 0; k < CN; k++) {
      re[0][k] = C.inL[k] * cWin[k];
      re[1][k] = C.inR[k] * cWin[k];
      im[0][k] = 0;
      im[1][k] = 0;
    }
    cFft.transform(re[0], im[0]);
    cFft.transform(re[1], im[1]);
    const cRe = new Float64Array(CN);
    const cIm = new Float64Array(CN);
    for (let k = LOW; k <= HIGH; k++) {
      const lr = re[0][k], li = im[0][k], rr = re[1][k], ri = im[1][k];
      const pl = lr * lr + li * li;
      const pr = rr * rr + ri * ri;
      const cross = Math.hypot(lr * rr + li * ri, li * rr - lr * ri);
      const sim = pl + pr > 1e-12 ? (2 * cross) / (pl + pr) : 0; // 1 = same in both channels
      const w = Math.min(1, Math.max(0, (sim - 0.55) / 0.4)) ** 2;
      const mr = ((lr + rr) / 2) * w;
      const mi = ((li + ri) / 2) * w;
      cRe[k] = mr;
      cIm[k] = mi;
      if (k > 0) {
        cRe[CN - k] = mr;
        cIm[CN - k] = -mi;
      }
    }
    // backing = each channel minus the centre; vocal = the centre
    const bL = [new Float64Array(CN), new Float64Array(CN)];
    const bR = [new Float64Array(CN), new Float64Array(CN)];
    const vc = [cRe.slice(), cIm.slice()];
    for (let k = 0; k < CN; k++) {
      bL[0][k] = re[0][k] - cRe[k];
      bL[1][k] = im[0][k] - cIm[k];
      bR[0][k] = re[1][k] - cRe[k];
      bR[1][k] = im[1][k] - cIm[k];
    }
    cFft.transform(bL[0], bL[1], true);
    cFft.transform(bR[0], bR[1], true);
    cFft.transform(vc[0], vc[1], true);
    for (let k = 0; k < CN; k++) {
      const g = cWin[k] / CN / 1.5; // hann^2 at 75 % overlap sums to 1.5
      C.olaL[k] += bL[0][k] * g;
      C.olaR[k] += bR[0][k] * g;
      C.olaV[0][k] += vc[0][k] * g;
    }
    // the first CH samples are complete now
    for (let k = 0; k < CH; k++) {
      outL.push(C.olaL[k]);
      outR.push(C.olaR[k]);
      vL.push(C.olaV[0][k]);
      vR.push(C.olaV[0][k]);
    }
    C.olaL.copyWithin(0, CH);
    C.olaR.copyWithin(0, CH);
    C.olaV[0].copyWithin(0, CH);
    C.olaL.fill(0, CN * 2 - CH);
    C.olaR.fill(0, CN * 2 - CH);
    C.olaV[0].fill(0, CN * 2 - CH);
  }
  return { inst: [Float32Array.from(outL), Float32Array.from(outR)], voc: [Float32Array.from(vL), Float32Array.from(vR)] };
}

const aiWait = new Map<number, { ok: (d: Float32Array) => void; bad: (e: Error) => void }>();
let aiId = 0;
function aiRun(spec: Float32Array, dims: number[]): Promise<Float32Array> {
  const id = ++aiId;
  return new Promise((ok, bad) => {
    aiWait.set(id, { ok, bad });
    S.session!.postMessage({ type: 'run', id, spec, dims }, [spec.buffer]);
  });
}

/** Stop waiting for the model (a jump, or a switch to the fast cut); `stop` also frees the CPU. */
function aiAbort(stop: boolean) {
  for (const p of aiWait.values()) p.bad(new Error('aborted'));
  aiWait.clear();
  if (stop && S.session) {
    S.session.terminate();
    S.session = null;
  }
}

/**
 * The light AI: Spleeter 2 stems (Deezer, open source, MIT) in ONNX. STFT 4096 / hop 1024; the models
 * see 512 frames (11.9 s) at a time and output vocal / accompaniment magnitudes; their ratio masks the
 * mix. Each run outputs NEW frames with PAST frames of context before and FUT after.
 */
const LN = 4096;
const LH = 1024;
const LW = 512;
const FUT = 40; // 0.9 s look-ahead
/** Frames out per run: small while little backing is ready (start fast), bigger once ahead (cheaper). */
function liteN() {
  const ahead = S.t0 + (S.lf * LH) / RATE - nowMedia();
  return ahead < 2.5 ? 48 : ahead < 5 ? 96 : 176;
}
const LB = 1024; // bins the model sees (up to 11 kHz); above that everything goes to the backing
const lWin = new Float64Array(LN).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / LN));
const lFft = new FFT(LN);
/** Samples of input the next light run needs. */
const liteNeed = (n: number) => (S.lf + n + FUT - 1) * LH + LN;

function liteRun(names: string[], spec: Float32Array, dims: number[]): Promise<Float32Array[]> {
  const id = ++aiId;
  return new Promise((ok, bad) => {
    aiWait.set(id, { ok: (_d: Float32Array, all?: Float32Array[]) => ok(all!), bad } as any);
    S.lite!.postMessage({ type: 'run', id, names, spec, dims }, [spec.buffer]);
  });
}

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (res.ok) return res.arrayBuffer();
  const man = await (await fetch(url + '.parts.json')).json();
  const buf = new Uint8Array(man.size);
  let o = 0;
  for (let i = 0; i < man.parts; i++) {
    const b = new Uint8Array(await (await fetch(`${url}.part${i}`)).arrayBuffer());
    buf.set(b, o);
    o += b.length;
  }
  return buf.buffer;
}

async function loadLite(base: string) {
  const [voc, acc] = await Promise.all([fetchModel(base + 'spleeter-vocals.onnx'), fetchModel(base + 'spleeter-accompaniment.onnx')]);
  const w = new Worker(chrome.runtime.getURL('aiworker.js'), { type: 'module' });
  await new Promise<void>((ok, bad) => {
    w.onmessage = (e) => (e.data.type === 'ready' ? ok() : bad(new Error(e.data.message)));
    w.onerror = (e) => bad(new Error(e.message || 'light AI worker failed'));
    // the light model is small: the CPU is plenty and leaves the graphics card alone
    w.postMessage(
      { type: 'init', models: [{ name: 'voc', bytes: voc }, { name: 'acc', bytes: acc }], eps: ['wasm'], wasmPaths: chrome.runtime.getURL('ort/'), threads: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2)) },
      [voc, acc],
    );
  });
  w.onmessage = (e) => {
    const p = aiWait.get(e.data.id) as any;
    if (!p) return;
    aiWait.delete(e.data.id);
    if (e.data.type === 'out') p.ok(e.data.data, e.data.all);
    else p.bad(new Error(e.data.message));
  };
  S.lite = w;
}

/** Start using the light AI from where the output has got to. */
function liteFromHere() {
  const outEnd = S.using === 'classic' ? Math.max(0, S.len - (CN - CH)) : S.done;
  S.lf = Math.ceil(outEnd / LH);
  S.using = 'lite';
}

/** One light-AI run: frames lf .. lf+NEW-1 become backing + vocal. False if not enough input yet. */
async function liteStep(): Promise<boolean | 'stale'> {
  const NEW = liteN();
  if (S.len < liteNeed(NEW)) return false;
  const f0 = S.lf;
  const a = f0 - (LW - NEW - FUT);
  const t1 = performance.now();
  const keep0 = f0 - 3; // frames that reach into the output region
  const keepN = NEW + 3;
  const X: { re: Float32Array; im: Float32Array }[][] = [[], []];
  const mag = new Float32Array(2 * LW * LB);
  const re = new Float64Array(LN);
  const im = new Float64Array(LN);
  for (let c = 0; c < 2; c++) {
    const src = c ? S.R : S.L;
    for (let f = 0; f < LW; f++) {
      const st = (a + f) * LH;
      for (let i = 0; i < LN; i++) {
        const j = st + i;
        re[i] = j >= 0 && j < S.len ? src[j] * lWin[i] : 0;
        im[i] = 0;
      }
      lFft.transform(re, im);
      const o = (c * LW + f) * LB;
      for (let k = 0; k < LB; k++) mag[o + k] = Math.hypot(re[k], im[k]);
      const kf = a + f - keep0;
      if (kf >= 0 && kf < keepN) X[c][kf] = { re: Float32Array.from(re.subarray(0, LN / 2 + 1)), im: Float32Array.from(im.subarray(0, LN / 2 + 1)) };
    }
  }
  const gen0 = S.resets;
  const [v, ac] = await liteRun(['voc', 'acc'], mag, [2, 1, LW, LB]);
  if (gen0 !== S.resets) return 'stale';
  // mask, inverse STFT, overlap-add over the output region
  const r0 = f0 * LH;
  const len = NEW * LH;
  const inst = [new Float32Array(len), new Float32Array(len)];
  const voc = [new Float32Array(len), new Float32Array(len)];
  const ir = new Float64Array(LN);
  const ii = new Float64Array(LN);
  const vr = new Float64Array(LN);
  const vi = new Float64Array(LN);
  const norm = 1 / (LN * 1.5); // inverse FFT scale; hann² at 75 % overlap sums to 1.5
  for (let c = 0; c < 2; c++) {
    for (let kf = 0; kf < keepN; kf++) {
      const fr = X[c][kf];
      const f = keep0 + kf - a; // index in the model's window
      const o = (c * LW + f) * LB;
      for (let k = 0; k <= LN / 2; k++) {
        let m = 1;
        if (k < LB) {
          // Spleeter's own ratio (power 2), never below a floor: soft instruments the model mistakes
          // for voice (piano, strings in ballads) are kept instead of disappearing
          const va = v[o + k] * v[o + k];
          const aa = ac[o + k] * ac[o + k];
          m = Math.max(0.12, (aa + 5e-11) / (va + aa + 1e-10));
        }
        ir[k] = fr.re[k] * m;
        ii[k] = fr.im[k] * m;
        vr[k] = fr.re[k] - ir[k];
        vi[k] = fr.im[k] - ii[k];
        if (k > 0 && k < LN / 2) {
          ir[LN - k] = ir[k];
          ii[LN - k] = -ii[k];
          vr[LN - k] = vr[k];
          vi[LN - k] = -vi[k];
        }
      }
      lFft.transform(ir, ii, true);
      lFft.transform(vr, vi, true);
      const st = (keep0 + kf) * LH - r0;
      for (let i = 0; i < LN; i++) {
        const j = st + i;
        if (j < 0 || j >= len) continue;
        const g = lWin[i] * norm;
        inst[c][j] += ir[i] * g;
        voc[c][j] += vr[i] * g;
      }
    }
  }
  S.speed = len / RATE / ((performance.now() - t1) / 1000);
  // how much quieter the backing is than the song here (smoothed): used to bring it back up
  let mi = 0;
  let bi = 0;
  for (let j = 0; j < len; j += 4) {
    const a = S.L[r0 + j] ?? 0;
    mi += a * a;
    bi += inst[0][j] * inst[0][j];
  }
  if (bi > 1e-9 && mi > 1e-9) S.makeup = S.makeup * 0.7 + 0.3 * Math.min(2.2, Math.max(1, 0.9 * Math.sqrt(mi / bi)));
  applyGains();
  const t = S.t0 + r0 / RATE;
  S.segs.push({ t, inst, voc });
  pitchFeed(t, voc);
  S.lf += NEW;
  S.done = (f0 + NEW) * LH;
  return true;
}

async function loadModel(url: string, base: string, key: string) {
  void base;
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
  // which runs this model faster here, graphics card or CPU: measured once, remembered
  const remembered = localStorage.getItem('ep.' + key);
  const eps = remembered ? [remembered] : 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  const cfg0 = MODELS[key];
  const w = new Worker(chrome.runtime.getURL('aiworker.js'), { type: 'module' });
  await new Promise<void>((ok, bad) => {
    w.onmessage = (e) => {
      if (e.data.type !== 'ready') return bad(new Error(e.data.message));
      if (!remembered && e.data.ep) localStorage.setItem('ep.' + key, e.data.ep);
      S.ep = e.data.ep;
      S.epTimes = e.data.times ?? {};
      ok();
    };
    w.onerror = (e) => bad(new Error(e.message || 'AI worker failed'));
    w.postMessage(
      {
        type: 'init',
        bytes,
        eps,
        probe: eps.length > 1 ? [1, 4, cfg0.dimF, cfg0.dimT] : undefined,
        wasmPaths: chrome.runtime.getURL('ort/'),
        threads: Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 2) - 1)),
      },
      [bytes],
    );
  });
  w.onmessage = (e) => {
    const p = aiWait.get(e.data.id);
    if (!p) return;
    aiWait.delete(e.data.id);
    if (e.data.type === 'out') p.ok(e.data.data);
    else p.bad(new Error(e.data.message));
  };
  S.session = w;
  S.cfg = MODELS[key];
  S.sp = new _Spectral(S.cfg);
}

/** Process as much of the buffered input as possible. */
async function work() {
  if (S.busy || !S.running) return;
  S.busy = true;
  try {
    for (;;) {
      if (S.using === 'lite') {
        let r: boolean | 'stale';
        try {
          r = await liteStep();
        } catch (e: any) {
          if (e?.message === 'aborted') {
            if (!S.running) break;
            continue;
          }
          throw e;
        }
        if (!S.running) break;
        if (r === 'stale') continue;
        if (!r) break;
        continue;
      }
      if (S.using === 'classic') {
        const n = S.len - S.done;
        if (n < 2048) break;
        const n0 = S.done;
        const { inst, voc } = classic(S.L.subarray(S.done, S.len), S.R.subarray(S.done, S.len));
        S.done = S.len;
        // output lags the input by one window: its first sample belongs to time (end - produced - lag)
        const lag = CN - CH;
        if (inst[0].length) {
          const st = S.t0 + (S.len - inst[0].length - lag) / RATE;
          S.segs.push({ t: st, inst, voc });
          pitchFeed(st, voc);
        }
        void n0;
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
      const gen0 = S.resets;
      let out: Float32Array;
      try {
        out = await aiRun(spec, [1, 4, cfg.dimF, cfg.dimT]);
      } catch (e: any) {
        if (e?.message === 'aborted') {
          if (!S.running) break;
          continue;
        }
        throw e;
      }
      if (!S.running) break;
      // a jump happened while the model worked: this window belongs to the old place, drop it
      if (gen0 !== S.resets || S.using !== 'ai') continue;
      void 0;
      const [yl, yr] = sp.istft(out);
      const secs = (performance.now() - t1) / 1000;
      S.speed = gen / RATE / secs;
      const prim = [yl.subarray(trim, trim + gen), yr.subarray(trim, trim + gen)].map((c) => c.map((v) => v * cfg.compensate));
      const mix = [wl.subarray(trim, trim + gen), wr.subarray(trim, trim + gen)];
      const other = mix.map((m, c) => m.map((v, i) => v - prim[c][i]));
      const inst = cfg.primary === 'instrumental' ? prim : other;
      const voc = cfg.primary === 'instrumental' ? other : prim;
      S.segs.push({ t: S.t0 + S.done / RATE, inst, voc });
      pitchFeed(S.t0 + S.done / RATE, voc);
      S.done += gen;
      if (S.mode === 'auto' && S.speed < 1.05) {
        S.using = 'classic'; // this computer cannot keep up: fall back
        toPage({ type: 'status', state: 'fallback', mode: 'classic', speed: S.speed });
      }
    }
  } catch (e: any) {
    S.lastError = String(e?.message ?? e);
    toPage({ type: 'status', state: 'error', message: S.lastError });
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
    S.played++;
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
    toPage({
      type: 'status', state: S.loadingModel ? 'loading' : 'running', mode: S.using, speed: S.speed, buffered: ahead,
      diag: { ep: S.ep, epTimes: S.epTimes, blocks: S.blocks, lastTap: S.lastTap, segments: S.segs.length, played: S.played, resets: S.resets, clock: S.clock.t, playing: S.clock.playing, ctx: ctx.state, err: S.lastError },
    });
  }
}, 250);

/** Use the light AI; the classic cut fills in while it loads (and if it cannot load). */
function startLite(base: string) {
  if (S.lite) {
    if (S.using !== 'lite') liteFromHere();
    void work();
    return;
  }
  S.using = 'classic';
  if (S.liteLoading) {
    // preloading: pick it up when it is ready
    const wait = window.setInterval(() => {
      if (S.liteLoading) return;
      window.clearInterval(wait);
      if (S.lite && S.mode === 'lite' && S.running) {
        liteFromHere();
        void work();
      }
    }, 100);
    return;
  }
  if (!base) return;
  S.liteLoading = true;
  S.loadingModel = true;
  loadLite(base)
    .finally(() => {
      S.liteLoading = false;
      S.loadingModel = false;
    })
    .then(() => {
      if (S.mode !== 'lite') return;
      liteFromHere();
      void work();
    })
    .catch((e) => toPage({ type: 'status', state: 'fallback', mode: 'classic', message: 'light AI: ' + String(e?.message ?? e) }));
}

let lostAt = 0;
chrome.runtime.onMessage.addListener((m: any, _s: unknown, reply: (x: unknown) => void) => {
  if (m?.to === 'engine-diag') {
    const rms = (a?: Float32Array) => (a && a.length ? Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length) : 0);
    const last = S.segs[S.segs.length - 1];
    const m0 = Math.max(0, S.len - 44100);
    reply({ instRms: rms(last?.inst[0]), vocRms: rms(last?.voc[0]), inRms: rms(S.L.subarray(m0, S.len)), instGain: instGain.gain.value, vocGain: vocGain.gain.value, shifter: !!shifter, key: wantKey, blocks: S.blocks, lastTap: S.lastTap, busy: S.busy, using: S.using, running: S.running, len: S.len, done: S.done, segs: S.segs.length, clock: S.clock, up: performance.now() / 1000 });
    return;
  }
  if (m?.to !== 'engine') return;
  const msg = m.msg as PageMsg | TapBlock;
  if (msg.type === 'tap') {
    if (!S.running) return;
    S.blocks++;
    S.lastTap = msg.t;
    append(msg.t, decode16(msg.l), decode16(msg.r));
    void work();
  } else if (msg.type === 'start') {
    S.running = true;
    P.buf = new Float32Array(0);
    S.blocks = 0;
    S.played = 0;
    S.resets = 0;
    S.lastError = '';
    S.mode = msg.mode;
    vocGain.gain.value = msg.vocal;
    S.vocal = msg.vocal;
    S.makeup = 1;
    void ctx.resume();
    reset(0);
    if (msg.mode === 'classic') S.using = 'classic';
    else if (msg.mode === 'lite') startLite((msg as any).liteBase);
    else {
      S.using = 'classic'; // until the model is ready
      toPage({ type: 'status', state: 'loading' });
      S.loadingModel = true;
      (S.session ? Promise.resolve() : loadModel(msg.modelUrl, msg.ortBase, msg.model))
        .finally(() => (S.loadingModel = false))
        .then(() => {
          S.using = 'ai';
          S.done = Math.max(0, S.len - (S.cfg!.nFft / 2)); // continue from here with the model
        })
        .catch((e) => toPage({ type: 'status', state: 'fallback', mode: 'classic', message: String(e?.message ?? e) }));
    }
  } else if ((msg as any).type === 'preload') {
    // a song page opened: get the light AI ready before the singer presses start
    if (!S.lite && !S.liteLoading && (msg as any).liteBase) {
      S.liteLoading = true;
      loadLite((msg as any).liteBase)
        .catch(() => {})
        .finally(() => (S.liteLoading = false));
    }
  } else if (msg.type === 'clock' && !S.running) {
    // the page is singing but this engine never got a start (Chrome reopened it): ask for one
    if (performance.now() - lostAt > 1000) {
      lostAt = performance.now();
      toPage({ type: 'status', state: 'lost' });
    }
  } else if (msg.type === 'clock') {
    const jumped = Math.abs(msg.t - nowMedia()) > 0.5;
    if (jumped || msg.playing !== S.clock.playing) unschedule();
    S.clock = { t: msg.t, at: performance.now(), playing: msg.playing };
  } else if ((msg as any).type === 'setmode') {
    // the page decided: e.g. too slow for the AI even with a long head start -> classic
    const mm = msg as any;
    const m = mm.mode as 'ai' | 'lite' | 'classic';
    S.mode = m;
    if (m === 'lite') {
      if (S.using === 'ai') {
        aiAbort(true);
        S.using = 'classic';
        S.done = S.len;
      }
      startLite(mm.liteBase);
    } else if (m === 'classic') {
      if (S.using === 'ai') S.done = S.len; // classic continues from the live edge
      S.using = 'classic';
      aiAbort(true);
      void work();
    } else if (m === 'ai' && S.using !== 'ai') {
      if (S.using === 'lite') {
        S.using = 'classic';
        S.done = S.len;
      }
      // the singer switched to the AI mid-song: load it if needed, then continue from the live edge
      const go = () => {
        if (S.mode !== 'ai') return;
        S.using = 'ai';
        S.done = Math.max(0, S.len - S.cfg!.nFft / 2);
      };
      if (S.session) go();
      else if (!S.loadingModel && mm.modelUrl) {
        S.loadingModel = true;
        toPage({ type: 'status', state: 'loading' });
        loadModel(mm.modelUrl, mm.ortBase, mm.model)
          .finally(() => (S.loadingModel = false))
          .then(go)
          .catch((e) => toPage({ type: 'status', state: 'fallback', mode: 'classic', message: String(e?.message ?? e) }));
      }
    }
  } else if ((msg as any).type === 'key') {
    setKey((msg as any).semitones);
  } else if (msg.type === 'vocal') {
    vocGain.gain.setTargetAtTime(msg.level, ctx.currentTime, 0.03);
    S.vocal = msg.level;
    applyGains();
  } else if (msg.type === 'stop') {
    S.running = false;
    unschedule();
    reset(0);
  }
});
