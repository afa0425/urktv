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
BAD = re.compile(r'cover|live|lyric|歌詞|歌词|動態|动态|伴奏|karaoke|ktv|翻唱|remix|reaction|教學|教学|1小時|1小时|1 hour|dj|純享|纯享|舞臺|舞台', re.I)
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
            # no official MV exists for some songs: the label's official lyric video is the next best
            s -= 1 if re.search(r'official', name, re.I) and re.search(r'lyric', name, re.I) and not re.search(r'cover|ktv|伴奏|karaoke|翻唱', name, re.I) else 5
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


def find_video(ytdlp: str, title: str, artist: str) -> dict | None:
    # several wordings: '… MV' sometimes finds nothing, the bare name with the artist usually does
    cjk = ''.join(re.findall(r'[\u3400-\u9fff]+', title))
    for q in dict.fromkeys([f'{artist} {title} MV', f'{artist} {title}', f'{artist} {cjk}' if cjk and cjk != title else '']):
        if not q:
            continue
        try:
            v = pick(search(ytdlp, q), title, artist)
        except Exception as e:  # keep the song even if the search fails
            print('  search failed:', title, e)
            v = None
        if v:
            return v
    return None


def fill_missing(path: str, ytdlp: str) -> None:
    """Look again for the songs of an existing chart file that have no video yet."""
    c = json.load(open(path, encoding='utf-8'))
    for l in c['lists']:
        for it in l['items']:
            if it.get('video'):
                continue
            artist = '' if it['artist'] == 'Various Artists' else it['artist']
            v = find_video(ytdlp, it['title'], artist)
            print(l['key'], it['rank'], it['title'], '->', v and (v['id'], v.get('title')))
            if v:
                it['video'] = v['id']
                it['duration'] = v.get('duration')
    json.dump(c, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=20)
    ap.add_argument('--out', default='public/charts.json')
    ap.add_argument('--yt-dlp', default='yt-dlp')
    ap.add_argument('--fill-missing', action='store_true', help='only look again for songs with no video')
    a = ap.parse_args()
    if a.fill_missing:
        return fill_missing(a.out, a.yt_dlp)
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
            v = find_video(a.yt_dlp, title, artist)
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
