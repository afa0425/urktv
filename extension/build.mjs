// Builds the extension into extension/dist (load it in chrome://extensions with "Load unpacked").
import { build } from 'esbuild';
import { cpSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
const out = 'dist';
mkdirSync(out + '/ort', { recursive: true });
const common = { bundle: true, minify: true, target: 'chrome120', logLevel: 'info' };
await build({ ...common, entryPoints: ['src/bridge.ts'], outfile: out + '/bridge.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/tap.ts'], outfile: out + '/tap.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/background.ts'], outfile: out + '/background.js', format: 'esm' });
await build({ ...common, entryPoints: ['src/aiworker.ts'], outfile: out + '/aiworker.js', format: 'esm' });
await build({ ...common, entryPoints: ['src/offscreen.ts'], outfile: out + '/offscreen.js', format: 'esm' });
for (const f of ['manifest.json', 'offscreen.html', 'icon128.png', 'pitch-worklet.js']) if (existsSync(f)) copyFileSync(f, `${out}/${f}`);
const ortDir = '../node_modules/onnxruntime-web/dist/';
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) copyFileSync(ortDir + f, `${out}/ort/${f}`);
console.log('extension built in extension/dist');
