// Dev check: run a separation model on a raw f32le stereo file with the same WASM runtime the browser uses.
// usage: npx vite-node scripts/sep-node.ts <model.onnx> <modelKey> <in.f32> <outDir> [seconds]
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ort from 'onnxruntime-web';
import { MODELS, separate } from '../src/separate/mdx';

const [modelPath, key, inPath, outDir, secs] = process.argv.slice(2);
const cfg = MODELS[key];
ort.env.wasm.numThreads = 4;

function wav(file: string, l: Float32Array, r: Float32Array) {
  const n = l.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(44100, 24); b.writeUInt32LE(44100 * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}

(async () => {
  const raw = fs.readFileSync(inPath);
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  let n = f.length / 2;
  if (secs) n = Math.min(n, Math.round(Number(secs) * 44100));
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(fs.readFileSync(modelPath), { executionProviders: ['wasm'] });
  console.log('inputs', session.inputNames, 'outputs', session.outputNames, 'load ms', Date.now() - t0);
  const t1 = Date.now();
  let tModel = 0;
  const st = await separate(L, R, cfg, async (x, dims) => {
    const a = Date.now();
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, dims) });
    tModel += Date.now() - a;
    return out[session.outputNames[0]].data as Float32Array;
  }, (d, t) => process.stdout.write(`\rchunk ${d}/${t}`));
  const total = (Date.now() - t1) / 1000;
  console.log(`\naudio ${(n / 44100).toFixed(1)} s, separation ${total.toFixed(1)} s (model ${(tModel / 1000).toFixed(1)} s), speed ${((n / 44100) / total).toFixed(2)}x realtime`);
  fs.mkdirSync(outDir, { recursive: true });
  wav(path.join(outDir, 'instrumental.wav'), ...st.instrumental);
  wav(path.join(outDir, 'vocals.wav'), ...st.vocals);
})();
