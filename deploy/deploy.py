"""Deploys a static folder to Cloudflare: files into a KV namespace + a Worker that serves them."""
import base64, json, os, sys, urllib.request

ACC = sys.argv[1]; SITE = sys.argv[2]; NAME = sys.argv[3]
SKIP_FILES = '--worker-only' in sys.argv
API = f'https://api.cloudflare.com/client/v4/accounts/{ACC}'
H = {'Authorization': 'Bearer proxy-injected'}

def call(method, path, body=None, ctype='application/json', raw=False):
    data = body if raw else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, data=data, method=method, headers={**H, 'Content-Type': ctype})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        raise SystemExit(f'{method} {path} -> {e.code}: {e.read()[:500]}')

# 1. KV namespace
title = f'{NAME}-site'
ns = next((n for n in call('GET', '/storage/kv/namespaces?per_page=100')['result'] if n['title'] == title), None)
if not ns:
    ns = call('POST', '/storage/kv/namespaces', {'title': title})['result']
print('kv namespace', ns['id'])

# 2. files, in bulk batches (base64 values)
files = []
for root, _, names in os.walk(SITE):
    for n in names:
        p = os.path.join(root, n)
        files.append((os.path.relpath(p, SITE).replace(os.sep, '/'), p))
batch, size = [], 0
keep_extra: set[str] = set()
def flush():
    global batch, size
    if batch:
        call('PUT', f"/storage/kv/namespaces/{ns['id']}/bulk", batch)
        print(f'  uploaded {len(batch)} files ({size / 1e6:.1f} MB)')
    batch, size = [], 0
for key, p in ([] if SKIP_FILES else sorted(files)):
    if key == '_headers':
        continue
    b = open(p, 'rb').read()
    # KV values are at most 25 MB: big files (AI models) go up in parts plus a small manifest
    PART = 20 * 1024 * 1024
    pieces = [(key, b)] if len(b) <= PART else \
        [(f'{key}.part{i}', b[o:o + PART]) for i, o in enumerate(range(0, len(b), PART))] + \
        [(f'{key}.parts.json', json.dumps({'parts': -(-len(b) // PART), 'size': len(b)}).encode())]
    for k, v in pieces:
        if size + len(v) > 40e6:
            flush()
        batch.append({'key': k, 'value': base64.b64encode(v).decode(), 'base64': True})
        size += len(v)
        if k != key:
            keep_extra.add(k)
flush()

# 2b. remove files that are no longer part of the site (e.g. audio taken down)
if not SKIP_FILES:
    keep = {k for k, _ in files} | keep_extra
    stale, cursor = [], ''
    while True:
        r = call('GET', f"/storage/kv/namespaces/{ns['id']}/keys?limit=1000" + (f'&cursor={cursor}' if cursor else ''))
        stale += [k['name'] for k in r['result'] if k['name'] not in keep]
        cursor = (r.get('result_info') or {}).get('cursor') or ''
        if not cursor:
            break
    for i in range(0, len(stale), 1000):
        call('POST', f"/storage/kv/namespaces/{ns['id']}/bulk/delete", stale[i:i + 1000])
    print(f'  removed {len(stale)} old files' + (f": {', '.join(x for x in stale if 'catalog' in x)}" if stale else ''))

# shared song library (notes + lyric timing uploaded by importers); separate from the site files
songs_title = f'{NAME}-songs'
songs_ns = next((n for n in call('GET', '/storage/kv/namespaces?per_page=100')['result'] if n['title'] == songs_title), None)
if not songs_ns:
    songs_ns = call('POST', '/storage/kv/namespaces', {'title': songs_title})['result']
print('song library', songs_ns['id'])

# 3. the Worker (password: set once with --password; kept afterwards)
pw = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--password=')), None)
meta = {'main_module': 'worker.js', 'compatibility_date': '2026-10-01',
        'bindings': [{'type': 'kv_namespace', 'name': 'SITE', 'namespace_id': ns['id']},
                     {'type': 'kv_namespace', 'name': 'SONGS', 'namespace_id': songs_ns['id']},
                     {'type': 'durable_object_namespace', 'name': 'ROOMS', 'class_name': 'Room'}],
        'keep_bindings': ['secret_text']}  # keep SITE_USER / SITE_PASS across deploys
boundary = 'hisingboundary'
src = open(os.path.join(os.path.dirname(__file__), 'worker.js'), 'rb').read()
def upload_worker(meta):
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'
            f'{json.dumps(meta)}\r\n--{boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
            'Content-Type: application/javascript+module\r\n\r\n').encode() + src + f'\r\n--{boundary}--\r\n'.encode()
    return call('PUT', f'/workers/scripts/{NAME}', body, f'multipart/form-data; boundary={boundary}', raw=True)


# rooms (Durable Objects): the class is created once with a migration; later uploads must not repeat it
try:
    upload_worker({**meta, 'migrations': {'new_tag': 'rooms-v1', 'new_sqlite_classes': ['Room']}})
except SystemExit as e:
    if 'migration' not in str(e).lower() and 'tag' not in str(e).lower():
        raise
    upload_worker(meta)
print('worker uploaded')
admin = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--admin-key=')), None)
upload = next((a.split('=', 1)[1] for a in sys.argv if a.startswith('--upload-key=')), None)
if pw or admin or upload:
    pairs = ([('SITE_USER', 'urktv'), ('SITE_PASS', pw)] if pw else []) + ([('ADMIN_KEY', admin)] if admin else []) \
        + ([('UPLOAD_KEY', upload)] if upload else [])
    for name, text in pairs:
        call('PUT', f'/workers/scripts/{NAME}/secrets', {'name': name, 'text': text, 'type': 'secret_text'})
    print('secrets set:', ', '.join(n for n, _ in pairs))
if '--no-password' in sys.argv:
    try:
        call('DELETE', f'/workers/scripts/{NAME}/secrets/SITE_PASS')
        print('password removed: the site is open')
    except SystemExit as e:
        print('no password to remove' if '404' in str(e) or '10056' in str(e) else e)

# 4. public on workers.dev
call('POST', f'/workers/scripts/{NAME}/subdomain', {'enabled': True, 'previews_enabled': True})
sub = call('GET', '/workers/subdomain')['result']['subdomain']
print(f'URL https://{NAME}.{sub}.workers.dev/')
