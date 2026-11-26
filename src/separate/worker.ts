/// <reference lib="webworker" />
// Heavy work off the main thread: AI vocal separation, guide-note extraction, key change.
import * as ort from 'onnxruntime-web/webgpu';
import { MODELS, separate } from './mdx';
import { downmix4, phraseLines, segmentNotes, trackPitch } from './notes';
import { pitchShift } from './pitchshift';

export type WorkerIn =
  | { type: 'separate'; left: Float32Array; right: Float32Array; model: string; modelUrl: string; ortBase: string }
  | { type: 'shift'; channels: Float32Array[]; semitones: number };

export type WorkerOut =
  | { type: 'progress'; stage: 'download' | 'load' | 'separate' | 'notes' | 'shift'; done: number; total: number; info?: string }
  | { type: 'separated'; instrumental: Float32Array[]; vocals: Float32Array[]; notes: any[]; lines: any[]; backend: string; seconds: number }
  | { type: 'shifted'; channels: Float32Array[] }
  | { type: 'error'; message: string };

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

const CACHE = 'hising-models-v1';

/** Downloads the model once and keeps it in the browser's cache storage. */
async function fetchModel(url: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null; // no cache storage (private mode): just download
  }
  let res = await fetch(url);
  if (res.status === 404) {
    // big models are stored in parts (hosting limit 25 MB per file)
    const man = await fetch(url + '.parts.json');
    if (man.ok) {
      const { parts, size } = (await man.json()) as { parts: number; size: number };
      const buf = new Uint8Array(size);
      let got = 0;
      for (let i = 0; i < parts; i++) {
        const r = await fetch(`${url}.part${i}`);
        if (!r.ok) throw new Error(`model part ${i} failed (${r.status})`);
        const b = new Uint8Array(await r.arrayBuffer());
        buf.set(b, got);
        got += b.length;
        post({ type: 'progress', stage: 'download', done: got, total: size });
      }
      try {
        await cache?.put(url, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } }));
      } catch {
        /* quota */
      }
      return buf.buffer;
    }
  }
  if (!res.ok || !res.body) throw new Error(`model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    post({ type: 'progress', stage: 'download', done: got, total });
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    await cache?.put(url, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    /* quota: fine, it downloads again next time */
  }
  return buf.buffer;
}

let session: { key: string; s: ort.InferenceSession; backend: string } | null = null;

/** WebGPU only with a hardware adapter: without one, the runtime can stall instead of failing over. */
async function hasRealGpu(): Promise<boolean> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return false;
  try {
    const a = await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 3000))]);
    return !!a && !(a as any).isFallbackAdapter;
  } catch {
    return false;
  }
}

async function getSession(key: string, url: string, ortBase: string) {
  if (session?.key === key) return session;
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const bytes = await fetchModel(url);
  post({ type: 'progress', stage: 'load', done: 0, total: 1 });
  const tries: string[] = (await hasRealGpu()) ? ['webgpu', 'wasm'] : ['wasm'];
  let last: unknown;
  for (const ep of tries) {
    try {
      const s = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [ep] });
      session = { key, s, backend: ep === 'wasm' ? `cpu×${ort.env.wasm.numThreads}` : 'webgpu' };
      return session;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// The runtime starts its CPU threads from this same script, named "em-pthread"; leave those to it.
if (self.name !== 'em-pthread') self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  try {
    if (m.type === 'separate') {
      const cfg = MODELS[m.model];
      const { s, backend } = await getSession(m.model, m.modelUrl, m.ortBase);
      const t0 = performance.now();
      const st = await separate(
        m.left,
        m.right,
        cfg,
        async (x, dims) => {
          const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, dims) });
          return out[s.outputNames[0]].data as Float32Array;
        },
        (done, total) => post({ type: 'progress', stage: 'separate', done, total, info: backend }),
      );
      const seconds = (performance.now() - t0) / 1000;
      post({ type: 'progress', stage: 'notes', done: 0, total: 1 });
      const mono = downmix4(st.vocals[0], st.vocals[1]);
      const notes = segmentNotes(trackPitch(mono));
      const lines = phraseLines(notes);
      const ch = [...st.instrumental, ...st.vocals];
      post({ type: 'separated', instrumental: st.instrumental, vocals: st.vocals, notes, lines, backend, seconds }, ch.map((c) => c.buffer));
    } else if (m.type === 'shift') {
      const out: Float32Array[] = [];
      m.channels.forEach((c, i) => {
        post({ type: 'progress', stage: 'shift', done: i, total: m.channels.length });
        out.push(pitchShift(c, m.semitones));
      });
      post({ type: 'shifted', channels: out }, out.map((c) => c.buffer));
    }
  } catch (e: any) {
    post({ type: 'error', message: e?.message ?? String(e) });
  }
};
