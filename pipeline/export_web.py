"""
Packs a decomposed song for the website: compressed tracks + a compact song file.

  public/catalog/<slug>/instrumental.mp3   backing track (stereo)
  public/catalog/<slug>/guide.mp3          original lead vocal (mono), mixed in by the vocal fader
  public/catalog/<slug>/song.json          notes, lyrics per character, pitch curve, highlights...
  public/catalog/index.json                list of songs

usage: python pipeline/export_web.py OUT_DIR --slug qingtian --title 晴天 --artist 周杰倫 \
           --video DYptgVvkVLQ [--video-offset 0] [--dest public/catalog]
"""
import argparse
import json
import subprocess
from pathlib import Path


def mp3(src: Path, dst: Path, mono: bool, kbps: int) -> None:
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(src)]
    if mono:
        cmd += ['-ac', '1']
    subprocess.run(cmd + ['-b:a', f'{kbps}k', str(dst)], check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('--slug', required=True)
    ap.add_argument('--title', required=True)
    ap.add_argument('--artist', default='')
    ap.add_argument('--video', default='', help='YouTube id of the MV shown (muted) on the stage')
    ap.add_argument('--video-offset', type=float, default=0, help='MV time at audio time 0 (seconds)')
    ap.add_argument('--dest', type=Path, default=Path('public/catalog'))
    ap.add_argument('--no-audio', action='store_true',
                    help='publish notes and lyrics only; the site plays the song from its YouTube MV')
    a = ap.parse_args()
    song = json.loads((a.out / 'song.json').read_text())
    d = a.dest / a.slug
    d.mkdir(parents=True, exist_ok=True)
    if a.no_audio:
        for f in ('instrumental.mp3', 'guide.mp3'):
            (d / f).unlink(missing_ok=True)
    else:
        mp3(a.out / 'instrumental.wav', d / 'instrumental.mp3', False, 192)
        mp3(a.out / 'lead.wav', d / 'guide.mp3', True, 128)

    r2 = lambda x: round(float(x), 2)  # noqa: E731
    notes = [{'s': r2(n['start']), 'e': r2(n['end']), 'm': r2(n.get('f0_median', n['midi'])),
              't': n.get('techniques', [])} for n in song['notes']]
    # pitch curve every 20 ms (enough to draw the original's slides and vibrato)
    f0 = song['f0']
    step = max(1, round(0.02 / f0['hop']))
    curve = [None if v is None else round(v, 1) for v in f0['midi'][::step]]
    lyrics = []
    for l in (song.get('lyrics') or {}).get('lines', []):
        lyrics.append({'s': r2(l['start']), 'e': r2(l['end']), 'text': l['text'],
                       'chars': [[r2(c['start']), r2(c['end']), c['text']] for c in l['chars']]})
    pkg = {
        'v': 1, 'audio': not a.no_audio, 'slug': a.slug, 'title': a.title, 'artist': a.artist,
        'duration': song['duration'], 'video': {'id': a.video, 'offset': a.video_offset} if a.video else None,
        'key': song.get('key'), 'range': song.get('range'), 'tempo': song.get('tempo_bpm'),
        'notes': notes, 'curve': {'hop': step * f0['hop'], 'midi': curve},
        'lyrics': lyrics, 'highlights': song.get('highlights', []), 'breaths': song.get('breaths', []),
    }
    (d / 'song.json').write_text(json.dumps(pkg, ensure_ascii=False, separators=(',', ':')))

    idx_path = a.dest / 'index.json'
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else {'songs': []}
    idx['songs'] = [s for s in idx['songs'] if s['slug'] != a.slug] + [{
        'slug': a.slug, 'title': a.title, 'artist': a.artist, 'duration': song['duration'],
        'video': a.video, 'key': song.get('key'), 'highest': (song.get('range') or {}).get('highest'),
    }]
    idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=1))
    print(f'packed {a.slug}: {len(notes)} notes, {len(lyrics)} lyric lines -> {d}')


if __name__ == '__main__':
    main()
