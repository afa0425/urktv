"""
Builds the home-page charts: KKBOX weekly song charts per language, each song matched to its
official music video on YouTube (search only, nothing is downloaded).

usage: python pipeline/charts.py [--top 20] [--out public/charts.json] [--yt-dlp yt-dlp]
"""
import argparse
import json
import re
import subprocess
import time
import urllib.request

CHARTS = [('zh', '華語', 297), ('tw', '台語', 304), ('yue', '粵語', 320), ('ja', '日語', 308), ('en', '西洋', 390), ('ko', '韓語', 314)]
API = 'https://kma.kkbox.com/charts/api/v1/weekly?category={}&lang=tc&limit=50&terr=tw&type=song'
BAD = re.compile(r'cover|live|lyric|歌詞|動態|伴奏|karaoke|ktv|翻唱|remix|reaction|教學|1小時|1 hour|dj', re.I)
GOOD = re.compile(r'official|mv|music video|官方|完整版', re.I)


def clean_title(t: str) -> str:
    t = re.split(r' - |（|\(|《|\[', t)[0]
    return t.strip()


def clean_artist(a: str) -> str:
    return re.split(r' \(|、|,|&| feat', a)[0].strip()


def search(ytdlp: str, q: str) -> list[dict]:
    out = subprocess.run([ytdlp, '--flat-playlist', '--no-warnings', '-j', f'ytsearch6:{q}'],
                         capture_output=True, text=True, timeout=60).stdout
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def pick(results: list[dict], title: str, artist: str) -> dict | None:
    best, score = None, -99
    for r in results:
        name = r.get('title') or ''
        ch = r.get('channel') or r.get('uploader') or ''
        dur = r.get('duration') or 0
        s = 0
        if BAD.search(name):
            s -= 5
        if GOOD.search(name):
            s += 2
        if title.lower()[:4] in name.lower():
            s += 2
        if artist and (artist.lower()[:3] in ch.lower() or artist.lower()[:3] in name.lower()):
            s += 2
        if r.get('channel_is_verified'):
            s += 1
        if not 120 <= dur <= 480:
            s -= 3
        if s > score:
            best, score = r, s
    return best if score >= 2 else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=20)
    ap.add_argument('--out', default='public/charts.json')
    ap.add_argument('--yt-dlp', default='yt-dlp')
    a = ap.parse_args()
    lists = []
    date = ''
    for key, label, cat in CHARTS:
        req = urllib.request.Request(API.format(cat), headers={'User-Agent': 'Mozilla/5.0'})
        data = json.load(urllib.request.urlopen(req, timeout=30))['data']
        date = data.get('date', date)
        items = []
        for s in data['charts']['song'][: a.top]:
            title, artist = clean_title(s['song_name']), clean_artist(s['artist_name'])
            v = None
            try:
                v = pick(search(a.yt_dlp, f'{artist} {title} MV'), title, artist)
            except Exception as e:  # keep the song even if the search fails
                print('  search failed:', title, e)
            r = s.get('rankings', {})
            items.append({
                'rank': r.get('this_period'), 'last': r.get('last_period'),
                'title': title, 'artist': artist, 'cover': (s.get('cover_image') or {}).get('small', ''),
                'video': v['id'] if v else '', 'videoTitle': v.get('title', '') if v else '',
                'duration': v.get('duration') if v else None,
            })
            print(f"  {key} #{items[-1]['rank']:>2} {title} - {artist} -> {items[-1]['video'] or '(no MV found)'}")
            time.sleep(0.3)
        lists.append({'key': key, 'label': label, 'items': items})
    json.dump({'updated': date, 'source': 'KKBOX 週榜', 'lists': lists}, open(a.out, 'w'), ensure_ascii=False, indent=1)
    print('wrote', a.out)


if __name__ == '__main__':
    main()
