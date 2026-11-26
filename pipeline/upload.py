"""
Uploads a decomposed song to the shared library: guide notes + lyric timing + pitch curve only.
The audio (backing track, vocals) stays on this computer.

usage: python pipeline/upload.py OUT_DIR --slug qingtian --title 晴天 --artist 周杰倫 --video DYptgVvkVLQ \
           --site https://urktv.afa0425.workers.dev --i-have-rights
       password: URKTV_PASS environment variable (user urktv, or URKTV_USER)
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from export_web import build_package  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('--slug', required=True)
    ap.add_argument('--title', required=True)
    ap.add_argument('--artist', default='')
    ap.add_argument('--video', required=True, help='YouTube id of the MV the notes are timed to')
    ap.add_argument('--video-offset', type=float, default=0)
    ap.add_argument('--site', required=True)
    ap.add_argument('--i-have-rights', action='store_true', help='you confirm you have the right to use this content')
    a = ap.parse_args()
    if not a.i_have_rights:
        sys.exit('Confirm you have the right to use this content: add --i-have-rights')
    song = json.loads((a.out / 'song.json').read_text())
    pkg = build_package(song, a.slug, a.title, a.artist, a.video, a.video_offset, audio=False)
    pkg['rights'] = True
    body = json.dumps(pkg, ensure_ascii=False, separators=(',', ':')).encode()
    req = urllib.request.Request(a.site.rstrip('/') + '/api/songs', data=body, method='POST',
                                 headers={'content-type': 'application/json', 'user-agent': 'urktv-uploader/1.0'})
    pw = os.environ.get('URKTV_PASS')
    if pw:
        tok = base64.b64encode(f"{os.environ.get('URKTV_USER', 'urktv')}:{pw}".encode()).decode()
        req.add_header('authorization', 'Basic ' + tok)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f'{e.code}: {e.read().decode()[:300]}')
    print(f'uploaded {a.slug}: {len(pkg["notes"])} notes, {len(pkg["lyrics"])} lyric lines ({len(body) // 1024} KB, no audio)')


if __name__ == '__main__':
    main()
