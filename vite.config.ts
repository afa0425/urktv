import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const EXT_VERSION = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;

// The import page needs cross-origin isolation so the AI model can use several CPU threads
// (SharedArrayBuffer). Only that page gets it: isolation would block the YouTube player elsewhere.
// Production hosts get the same headers from public/_headers.
const isolateImportPage = (): Plugin => {
  const add = (req: { url?: string }, res: { setHeader(k: string, v: string): void }) => {
    const url = req.url ?? '';
    if (url.startsWith('/import.html') || url.startsWith('/bench.html')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    } else if (!url.endsWith('.html') && url !== '/' && !url.startsWith('/?')) {
      // a worker started from the isolated page must itself be served with COEP, or it fails to load
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
  };
  return {
    name: 'isolate-import-page',
    configureServer: (s) => void s.middlewares.use((req, res, next) => (add(req, res), next())),
    configurePreviewServer: (s) => void s.middlewares.use((req, res, next) => (add(req, res), next())),
  };
};

// base './' so the built site works from any path (GitHub Pages, Cloudflare Pages, a subfolder…)
export default defineConfig({
  base: './',
  define: { __EXT_VERSION__: JSON.stringify(EXT_VERSION) },
  plugins: [react(), isolateImportPage()],
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  worker: { format: 'es' },
  build: {
    rollupOptions: { input: { main: 'index.html', import: 'import.html', bench: 'bench.html' } },
  },
});
