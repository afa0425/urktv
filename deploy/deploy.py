"""Deploys a static folder to Cloudflare: files into a KV namespace + a Worker that serves them."""
import base64, json, os, sys, urllib.request

ACC = sys.argv[1]; SITE = sys.argv[2]; NAME = sys.argv[3]
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
def flush():
    global batch, size
    if batch:
        call('PUT', f"/storage/kv/namespaces/{ns['id']}/bulk", batch)
        print(f'  uploaded {len(batch)} files ({size / 1e6:.1f} MB)')
    batch, size = [], 0
for key, p in sorted(files):
    if key == '_headers':
        continue
    b = open(p, 'rb').read()
    if len(b) > 25 * 1024 * 1024:
        print('  skip (over 25 MB):', key); continue
    if size + len(b) > 40e6:
        flush()
    batch.append({'key': key, 'value': base64.b64encode(b).decode(), 'base64': True})
    size += len(b)
flush()

# 3. the Worker
meta = {'main_module': 'worker.js', 'compatibility_date': '2026-10-01',
        'bindings': [{'type': 'kv_namespace', 'name': 'SITE', 'namespace_id': ns['id']}]}
boundary = 'hisingboundary'
src = open(os.path.join(os.path.dirname(__file__), 'worker.js'), 'rb').read()
body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'
        f'{json.dumps(meta)}\r\n--{boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
        'Content-Type: application/javascript+module\r\n\r\n').encode() + src + f'\r\n--{boundary}--\r\n'.encode()
call('PUT', f'/workers/scripts/{NAME}', body, f'multipart/form-data; boundary={boundary}', raw=True)
print('worker uploaded')

# 4. public on workers.dev
call('POST', f'/workers/scripts/{NAME}/subdomain', {'enabled': True, 'previews_enabled': True})
sub = call('GET', '/workers/subdomain')['result']['subdomain']
print(f'URL https://{NAME}.{sub}.workers.dev/')
