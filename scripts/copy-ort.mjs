// Copies the ONNX Runtime WebAssembly files next to the site (public/ort/), so the AI runs without a CDN.
import { copyFileSync, mkdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist/';
mkdirSync('public/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copyFileSync(src + f, 'public/ort/' + f);
}
console.log('copied onnxruntime-web files to public/ort/');
