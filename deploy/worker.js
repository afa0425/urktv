// Serves the static site from Workers KV (keys are paths without the leading slash).
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', wasm: 'application/wasm',
  mp3: 'audio/mpeg', png: 'image/png', svg: 'image/svg+xml', onnx: 'application/octet-stream', txt: 'text/plain; charset=utf-8',
};
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (key === '' || key.endsWith('/')) key += 'index.html';
    let { value, metadata } = await env.SITE.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 300 });
    if (value === null && !key.includes('.')) {
      key = 'index.html';
      ({ value, metadata } = await env.SITE.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 300 }));
    }
    if (value === null) return new Response('Not found', { status: 404 });
    const ext = key.split('.').pop().toLowerCase();
    const h = new Headers({ 'content-type': TYPES[ext] || 'application/octet-stream' });
    h.set('cache-control', key.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
    if (key === 'import.html') {
      // the import page runs cross-origin isolated (multi-threaded AI)
      h.set('cross-origin-opener-policy', 'same-origin');
      h.set('cross-origin-embedder-policy', 'require-corp');
    } else if (!key.endsWith('.html')) {
      h.set('cross-origin-embedder-policy', 'require-corp');
    }
    // range requests for audio seeking
    const range = req.headers.get('range');
    if (range && ext === 'mp3') {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const size = value.byteLength;
      const start = m && m[1] ? +m[1] : 0;
      const end = m && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      h.set('content-range', `bytes ${start}-${end}/${size}`);
      h.set('accept-ranges', 'bytes');
      return new Response(value.slice(start, end + 1), { status: 206, headers: h });
    }
    return new Response(value, { headers: h });
  },
};
