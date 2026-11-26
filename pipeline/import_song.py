"""
One-command import, run on the importer's own computer (GPU recommended):
  your audio file -> six-stage decomposition -> scraped lyrics aligned -> notes uploaded.
The backing track and vocals stay on this computer; only notes and lyric timing are uploaded.
Like KAREOKIE, the tool does not download songs: bring a file you have the right to use.

usage:
  python pipeline/import_song.py SONG.mp3 --title 晴天 --artist 周杰倫 --video DYptgVvkVLQ \
      --work D:/urktv-work --site https://urktv.afa0425.workers.dev --i-have-rights
  (website password in the URKTV_PASS environment variable)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent


def slugify(title: str, artist: str, video: str) -> str:
    base = re.sub(r'[^a-z0-9]+', '-', f'{artist} {title}'.lower()).strip('-')
    return (base or 'song')[:40].strip('-') + '-' + video[:6].lower().replace('_', 'x')


def find_lrc(title: str, artist: str, duration: float) -> str | None:
    """Synced lyrics from LRCLIB (public, free); the version closest in length wins."""
    q = urllib.parse.urlencode({'track_name': title, 'artist_name': artist})
    req = urllib.request.Request('https://lrclib.net/api/search?' + q, headers={'User-Agent': 'urktv-importer/1.0'})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:
        print('lyrics search failed:', e)
        return None
    synced = [r for r in res if r.get('syncedLyrics')]
    if not synced:
        return None
    best = min(synced, key=lambda r: abs((r.get('duration') or 0) - duration))
    return best['syncedLyrics']


def run(*cmd: str) -> None:
    print('>', ' '.join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('song', type=Path, help='an audio or video file you have the right to use')
    ap.add_argument('--title', required=True)
    ap.add_argument('--artist', default='')
    ap.add_argument('--video', required=True, help='YouTube id of the official MV this audio comes from')
    ap.add_argument('--video-offset', type=float, default=0, help='MV time at audio time 0')
    ap.add_argument('--slug')
    ap.add_argument('--work', type=Path, required=True, help='folder holding models/, code/ and results (see setup)')
    ap.add_argument('--site', required=True)
    ap.add_argument('--lrc', type=Path, help='use this LRC file instead of searching LRCLIB')
    ap.add_argument('--no-upload', action='store_true')
    ap.add_argument('--i-have-rights', action='store_true')
    a = ap.parse_args()
    if not a.i_have_rights:
        sys.exit('Confirm you have the right to use this content: add --i-have-rights')
    slug = a.slug or slugify(a.title, a.artist, a.video)
    out = a.work / 'songs' / slug
    py = sys.executable

    # 1-6: decomposition (stages already done are skipped)
    run(py, HERE / 'decompose.py', a.song, '--out', out, '--models', a.work / 'models',
        '--some', a.work / 'code' / 'SOME', '--rmvpe', a.work / 'code' / 'RMVPE')
    song = json.loads((out / 'song.json').read_text())

    # lyrics: scraped, then anchored on what the lead vocal sings
    lrc = a.lrc
    if not lrc:
        text = find_lrc(a.title, a.artist, song['duration'])
        if text:
            lrc = out / 'lyrics.lrc'
            lrc.write_text(text, encoding='utf8')
    if lrc:
        run(py, HERE / 'lyrics.py', out, lrc, '--trad')
    else:
        print('no synced lyrics found: the song is uploaded with notes only')

    # report image for a quick look
    try:
        run(py, HERE / 'report.py', out, out / 'report.png')
    except subprocess.CalledProcessError:
        pass

    if a.no_upload:
        print('done (not uploaded):', out)
        return
    run(py, HERE / 'upload.py', out, '--slug', slug, '--title', a.title, '--artist', a.artist,
        '--video', a.video, '--video-offset', str(a.video_offset), '--site', a.site, '--i-have-rights')
    print(f'done: {a.title} -> {a.site.rstrip("/")}/  (audio kept in {out})')


if __name__ == '__main__':
    main()
