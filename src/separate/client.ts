// Main-thread side of the worker.
import type { WorkerIn, WorkerOut } from './worker';

export const MODEL_BASE: string = (import.meta as any).env?.VITE_MODEL_BASE || new URL('models/', document.baseURI).href;
export const ORT_BASE: string = new URL('ort/', document.baseURI).href;

export function runWorker(msg: WorkerIn, onProgress?: (p: Extract<WorkerOut, { type: 'progress' }>) => void, transfer: Transferable[] = []) {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const done = new Promise<WorkerOut>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const d = e.data;
      if (d.type === 'progress') onProgress?.(d);
      else {
        w.terminate();
        if (d.type === 'error') reject(new Error(d.message));
        else resolve(d);
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'worker failed'));
    };
  });
  w.postMessage(msg, transfer);
  return { done, cancel: () => w.terminate() };
}

/** Decodes any audio/video file the browser can play to 44.1 kHz stereo. */
export async function decodeFile(file: File): Promise<[Float32Array, Float32Array]> {
  const data = await file.arrayBuffer();
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
  const tmp = new Ctx();
  let buf: AudioBuffer;
  try {
    buf = await tmp.decodeAudioData(data);
  } finally {
    void tmp.close();
  }
  const len = Math.ceil(buf.duration * 44100);
  const off = new OfflineAudioContext(2, len, 44100);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return [r.getChannelData(0).slice(), r.getChannelData(r.numberOfChannels > 1 ? 1 : 0).slice()];
}
