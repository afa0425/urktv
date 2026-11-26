// Runs the AI model off the engine's thread, so the engine keeps taking in the video's sound and
// playing the backing while the model works.
import * as ort from 'onnxruntime-web/webgpu';

let session: ort.InferenceSession | null = null;

// ORT starts its helper threads from this same file (named em-pthread): leave those to ORT
if ((self as any).name !== 'em-pthread') self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      ort.env.wasm.wasmPaths = m.wasmPaths;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? m.threads : 1;
      (ort.env.webgpu as any).powerPreference = 'high-performance';
      let used = '';
      for (const ep of m.eps as string[]) {
        try {
          session = await ort.InferenceSession.create(new Uint8Array(m.bytes), { executionProviders: [ep] });
          used = ep;
          break;
        } catch {
          /* next */
        }
      }
      if (!session) throw new Error('model failed to load');
      postMessage({ type: 'ready', ep: used });
    } else if (m.type === 'run') {
      const out = await session!.run({ [session!.inputNames[0]]: new ort.Tensor('float32', m.spec, m.dims) });
      const data = new Float32Array(out[session!.outputNames[0]].data as Float32Array);
      (postMessage as any)({ type: 'out', id: m.id, data }, [data.buffer]);
    }
  } catch (err: any) {
    postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};
