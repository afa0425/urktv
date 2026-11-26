// Runs the AI models off the engine's thread, so the engine keeps taking in the video's sound and
// playing the backing while the models work. Holds one or more named models.
import * as ort from 'onnxruntime-web/webgpu';

const sessions = new Map<string, ort.InferenceSession>();

async function create(bytes: ArrayBuffer, eps: string[]) {
  for (const ep of eps) {
    try {
      return { s: await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [ep] }), ep };
    } catch {
      /* next */
    }
  }
  throw new Error('model failed to load');
}

// ORT starts its helper threads from this same file (named em-pthread): leave those to ORT
if ((self as any).name !== 'em-pthread')
  self.onmessage = async (e: MessageEvent) => {
    const m = e.data;
    try {
      if (m.type === 'init') {
        ort.env.wasm.wasmPaths = m.wasmPaths;
        ort.env.wasm.numThreads = self.crossOriginIsolated ? m.threads : 1;
        (ort.env.webgpu as any).powerPreference = 'high-performance';
        const models: { name: string; bytes: ArrayBuffer }[] = m.models ?? [{ name: 'main', bytes: m.bytes }];
        let used = '';
        const times: Record<string, number> = {};
        for (const md of models) {
          if (m.probe && m.eps.length > 1) {
            // the graphics card is not always faster (built-in GPUs often lose to the CPU): time one
            // window on each and keep the faster
            let best: { s: ort.InferenceSession; ep: string; t: number } | null = null;
            for (const ep of m.eps as string[]) {
              try {
                const s = await ort.InferenceSession.create(new Uint8Array(md.bytes), { executionProviders: [ep] });
                const x = new Float32Array(m.probe.reduce((a: number, b: number) => a * b, 1));
                await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, m.probe) }); // warm-up
                const t0 = performance.now();
                await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, m.probe) });
                const t = performance.now() - t0;
                times[ep] = Math.round(t);
                if (!best || t < best.t) {
                  if (best) await best.s.release();
                  best = { s, ep, t };
                } else await s.release();
              } catch {
                /* this one cannot run here */
              }
            }
            if (!best) throw new Error('model failed to load');
            sessions.set(md.name, best.s);
            used = best.ep;
          } else {
            const r = await create(md.bytes, m.eps);
            sessions.set(md.name, r.s);
            used = r.ep;
          }
        }
        postMessage({ type: 'ready', ep: used, times });
      } else if (m.type === 'run') {
        // every named model (or just `name`) on the same input; outputs in the same order
        const names: string[] = m.names ?? ['main'];
        const outs: Float32Array[] = [];
        for (const n of names) {
          const s = sessions.get(n)!;
          const o = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', m.spec, m.dims) });
          outs.push(new Float32Array(o[s.outputNames[0]].data as Float32Array));
        }
        (postMessage as any)({ type: 'out', id: m.id, data: outs[0], all: outs }, outs.map((x) => x.buffer));
      }
    } catch (err: any) {
      postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
    }
  };
