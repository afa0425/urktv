// Serves the static site from Workers KV (keys are paths without the leading slash).
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', wasm: 'application/wasm',
  mp3: 'audio/mpeg', png: 'image/png', svg: 'image/svg+xml', onnx: 'application/octet-stream', txt: 'text/plain; charset=utf-8',
};
// ---------- shared song library: guide notes + lyric timing only, never audio ----------
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const MAX_SONG = 600 * 1024; // a song file is notes, lyrics and a pitch curve: well under this

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function checkSong(p) {
  if (!p || typeof p !== 'object') return 'not a song';
  if (p.audio) return 'audio is not accepted: notes and lyrics only';
  if (!SLUG.test(p.slug || '')) return 'slug: lowercase letters, digits and dashes';
  if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 120) return 'title';
  if (p.artist != null && (typeof p.artist !== 'string' || p.artist.length > 120)) return 'artist';
  if (!p.video || !VIDEO.test(p.video.id || '') || typeof (p.video.offset ?? 0) !== 'number') return 'video: a YouTube id';
  if (!Array.isArray(p.notes) || p.notes.length < 10 || p.notes.length > 5000) return 'notes';
  for (const n of p.notes) if (!(n && n.e > n.s && n.s >= 0 && n.m > 20 && n.m < 110)) return 'a note is invalid';
  if (!Array.isArray(p.lyrics) || p.lyrics.length > 400) return 'lyrics';
  return null;
}

async function api(req, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  if (!env.SONGS) return json({ error: 'song library not configured' }, 503);
  // list
  if (path === 'songs' && req.method === 'GET') {
    const idx = (await env.SONGS.get('index', { type: 'json' })) || { songs: [] };
    return json(idx);
  }
  const m = /^songs\/([a-z0-9-]+)$/.exec(path);
  if (m && req.method === 'GET') {
    const song = await env.SONGS.get('song:' + m[1]);
    return song ? new Response(song, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' } }) : json({ error: 'not found' }, 404);
  }
  // upload (the importer sends notes + lyric timing; the audio stays on the importer's computer)
  if (path === 'songs' && req.method === 'POST') {
    // only importers with the upload key may add songs (the site itself is open)
    if (env.UPLOAD_KEY && req.headers.get('x-upload-key') !== env.UPLOAD_KEY) return json({ error: 'upload key required' }, 403);
    const body = await req.text();
    if (body.length > MAX_SONG) return json({ error: 'too large' }, 413);
    let p;
    try {
      p = JSON.parse(body);
    } catch {
      return json({ error: 'not JSON' }, 400);
    }
    const bad = checkSong(p);
    if (bad) return json({ error: bad }, 400);
    if (!p.rights) return json({ error: 'confirm you have the right to use this content (rights: true)' }, 400);
    const pkg = { ...p, audio: false, rights: undefined, uploadedAt: new Date().toISOString() };
    await env.SONGS.put('song:' + p.slug, JSON.stringify(pkg));
    const idx = (await env.SONGS.get('index', { type: 'json' })) || { songs: [] };
    const entry = {
      slug: p.slug, title: p.title, artist: p.artist || '', duration: p.duration || 0, video: p.video.id,
      key: p.key || null, highest: (p.range && p.range.highest) || null, notes: p.notes.length, lines: p.lyrics.length,
      updatedAt: pkg.uploadedAt,
    };
    idx.songs = [entry, ...idx.songs.filter((x) => x.slug !== p.slug)];
    await env.SONGS.put('index', JSON.stringify(idx));
    return json({ ok: true, slug: p.slug, songs: idx.songs.length });
  }
  // problem reports, and takedown for copyright requests (admin only)
  if (path === 'report' && req.method === 'POST') {
    let r;
    try {
      r = await req.json();
    } catch {
      return json({ error: 'not JSON' }, 400);
    }
    if (!SLUG.test(r.slug || '')) return json({ error: 'slug' }, 400);
    const key = 'reports:' + r.slug;
    const list = (await env.SONGS.get(key, { type: 'json' })) || [];
    list.push({ at: new Date().toISOString(), issue: String(r.issue || '').slice(0, 40), note: String(r.note || '').slice(0, 500), t: Number(r.t) || null });
    await env.SONGS.put(key, JSON.stringify(list.slice(-200)));
    return json({ ok: true });
  }
  const del = /^songs\/([a-z0-9-]+)$/.exec(path);
  if (del && req.method === 'DELETE') {
    if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
    await env.SONGS.delete('song:' + del[1]);
    const idx = (await env.SONGS.get('index', { type: 'json' })) || { songs: [] };
    idx.songs = idx.songs.filter((x) => x.slug !== del[1]);
    await env.SONGS.put('index', JSON.stringify(idx));
    return json({ ok: true, removed: del[1] });
  }
  return json({ error: 'not found' }, 404);
}

// Private for now: HTTP Basic auth with the SITE_USER / SITE_PASS Worker secrets.
function authorized(req, env) {
  if (!env.SITE_PASS) return true;
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let pair = '';
  try {
    pair = atob(h.slice(6));
  } catch {
    return false;
  }
  const i = pair.indexOf(':');
  const user = pair.slice(0, i);
  const pass = pair.slice(i + 1);
  // constant-time-ish compare
  const want = `${env.SITE_USER || 'urktv'}:${env.SITE_PASS}`;
  const got = `${user}:${pass}`;
  let diff = want.length ^ got.length;
  for (let k = 0; k < Math.max(want.length, got.length); k++) diff |= (want.charCodeAt(k) || 0) ^ (got.charCodeAt(k) || 0);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    if (!authorized(req, env)) {
      return new Response('需要登入 / Login required', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="URKTV", charset="UTF-8"', 'cache-control': 'no-store' },
      });
    }
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return api(req, env, url);
    let key = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (key === '' || key.endsWith('/')) key += 'index.html';
    if (key === 'robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    let { value, metadata } = await env.SITE.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 300 });
    if (value === null && !key.includes('.')) {
      key = 'index.html';
      ({ value, metadata } = await env.SITE.getWithMetadata(key, { type: 'arrayBuffer', cacheTtl: 300 }));
    }
    if (value === null) return new Response('Not found', { status: 404 });
    const ext = key.split('.').pop().toLowerCase();
    const h = new Headers({ 'content-type': TYPES[ext] || 'application/octet-stream' });
    h.set('cache-control', key.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'private, max-age=60');
    h.set('x-robots-tag', 'noindex, nofollow');
    if (key === 'import.html' || key === 'bench.html') {
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
