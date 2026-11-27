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
import unicodedata
import urllib.parse
import urllib.request

CHARTS = [('zh', '華語', 297), ('tw', '台語', 304), ('yue', '粵語', 320), ('ja', '日語', 308), ('en', '西洋', 390), ('ko', '韓語', 314)]
API = 'https://kma.kkbox.com/charts/api/v1/weekly?category={}&lang=tc&limit=50&terr=tw&type=song'
# not the song as recorded: never
BAD = re.compile(r'cover|live|伴奏|karaoke|ktv|翻唱|remix|reaction|教學|教学|1小時|1小时|1 hour|dj|純享|纯享|舞臺|舞台'
                 r'|concert|演唱會|演唱会|dance practice|performance|show!|仿mv|fan ?made|新歌會|新歌会|音樂榜|音乐榜|teaser|預告|预告|shorts|合輯|合辑|串燒'
                 r'|tour|arena|first take|acoustic|amv|piano|instrumental|sped up|slowed|nightcore|8d|紅白|歌合戦|文化祭|歌うま|ドッキリ|歌ってみた|弾いてみた', re.I)
# the song as recorded, but somebody's lyric upload: only when nothing better exists
SOFT = re.compile(r'lyric|歌詞|歌词|動態|动态|ซับ|vietsub|sub español|pinyin|拼音|字幕', re.I)
GOOD = re.compile(r'official|mv|music video|官方|完整版', re.I)
LRCLIB = 'https://lrclib.net/api/search?track_name={}&artist_name={}'


def clean_title(t: str) -> str:
    t = re.split(r' - |（|\(|《|\[', t)[0]
    return t.strip()


def clean_artist(a: str) -> str:
    return re.split(r' \(|、|,|&| feat', a)[0].strip()


def norm(s: str) -> str:
    return re.sub(r'[\W_]+', '', unicodedata.normalize('NFKC', s).lower())


def name_fit(a: str, b: str) -> float:
    """How well name a is found in b, in order (1 = b contains it whole). Tolerates 繁/简 spellings."""
    A, B = norm(a), norm(b)
    if not A or not B:
        return 0.0
    if A in B:
        return 1.0
    prev = [0] * (len(B) + 1)
    for x in A:
        cur = [0]
        for j in range(1, len(B) + 1):
            cur.append(prev[j - 1] + 1 if x == B[j - 1] else max(prev[j], cur[j - 1]))
        prev = cur
    return prev[len(B)] / len(A) * 0.8


CJK = r'぀-ヿ㐀-鿿가-힯'
SAME = str.maketrans('妳祢', '你你')


def title_fit(title: str, name: str) -> bool:
    """Does the video's title carry the song's name (whole, or its Chinese part)?"""
    title, name = (unicodedata.normalize('NFKC', x).translate(SAME) for x in (title, name))
    forms = [title]
    cjk = ''.join(re.findall(f'[{CJK}]+', title))
    if cjk and cjk != title and len(cjk) >= 2:
        forms.append(cjk)
    for f in forms:
        n = norm(f)
        is_cjk = bool(re.search(f'[{CJK}]', f))
        if len(n) <= (2 if is_cjk else 4):
            # a short name is in many titles (她 in 她他, Zoo in Zootopia): it must stand on its own
            edge = f'[{CJK}]' if is_cjk else '[a-z0-9]'
            if re.search(f'(?<!{edge}){re.escape(f.lower())}(?!{edge})', name.lower()):
                return True
        elif name_fit(f, name) >= (0.6 if is_cjk and len(n) >= 4 else 0.75):
            # (one character written another way still counts in a Chinese name; Latin letters must all be there)
            return True
    return False


def track_length(title: str, artist: str) -> float:
    """Length of the recording the public synced lyrics are timed to (0 = unknown)."""
    try:
        url = LRCLIB.format(urllib.parse.quote(title), urllib.parse.quote(artist))
        req = urllib.request.Request(url, headers={'User-Agent': 'urktv-charts'})
        for c in json.load(urllib.request.urlopen(req, timeout=20)):
            if c.get('syncedLyrics') and name_fit(title, c.get('trackName') or '') >= 0.6:
                return float(c.get('duration') or 0)
    except Exception:
        pass
    return 0.0


def search(ytdlp: str, q: str) -> list[dict]:
    out = subprocess.run([ytdlp, '--flat-playlist', '--no-warnings', '-j', f'ytsearch8:{q}'],
                         capture_output=True, text=True, timeout=90).stdout
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def rate(r: dict, title: str, artist: str, track: float = 0) -> float:
    """Score of one search result for this song; below 2 it is not this song's video."""
    name = unicodedata.normalize('NFKC', r.get('title') or '')
    ch = r.get('channel') or r.get('uploader') or ''
    dur = r.get('duration') or 0
    by_artist = bool(artist) and (name_fit(artist, ch) >= 0.7 or name_fit(artist, name) >= 0.7)
    same_len = track > 0 and dur > 0 and abs(dur - track) <= 2.5
    # another song's video is worse than no video: the name must be there, or (a name written in
    # another language: Idol / アイドル) it is the singer's own official video of exactly that length
    if not title_fit(title, name) and not (by_artist and same_len and GOOD.search(name)):
        return -99
    s = 2.0
    if BAD.search(name):
        s -= 5
    elif SOFT.search(name):
        # no official MV exists for some songs: a lyric video of the recording is the next best
        s -= 1 if re.search(r'official', name, re.I) else 2
    if GOOD.search(name):
        s += 2
    if by_artist:
        s += 2
    elif artist:
        s -= 1
    if r.get('channel_is_verified'):
        s += 1
    if not 120 <= dur <= 480:
        s -= 3
    # as long as the recording the lyrics are timed to: the lyrics fit without any guessing
    if same_len:
        s += 1.5
    elif track > 0 and dur > 0 and (dur - track < -8 or dur - track > 60):
        s -= 2
    return s


def pick(results: list[dict], title: str, artist: str, track: float = 0) -> dict | None:
    best, score = None, -99.0
    for r in results:
        s = rate(r, title, artist, track)
        if s > score:
            best, score = r, s
    return best if score >= 2 else None


def find_video(ytdlp: str, title: str, artist: str, track: float = 0) -> dict | None:
    # several wordings: '… MV' sometimes finds nothing, the bare name with the artist usually does
    cjk = ''.join(re.findall(r'[\u3400-\u9fff]+', title))
    for q in dict.fromkeys([f'{artist} {title} MV', f'{artist} {title}', f'{artist} {cjk}' if cjk and cjk != title else '']):
        if not q:
            continue
        try:
            v = pick(search(ytdlp, q), title, artist, track)
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
            v = find_video(ytdlp, it['title'], artist, track_length(it['title'], artist))
            print(l['key'], it['rank'], it['title'], '->', v and (v['id'], v.get('title')))
            if v:
                it['video'] = v['id']
                it['videoTitle'] = v.get('title', '')
                it['duration'] = v.get('duration')
    json.dump(c, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def recheck(path: str, ytdlp: str) -> None:
    """Go through an existing chart file: a video that is not this song's is replaced (or removed)."""
    c = json.load(open(path, encoding='utf-8'))
    for l in c['lists']:
        for it in l['items']:
            artist = '' if it['artist'] == 'Various Artists' else it['artist']
            track = track_length(it['title'], artist)
            cur = {'title': it.get('videoTitle') or '', 'duration': it.get('duration') or 0, 'channel': ''}
            ok = bool(it.get('video')) and cur['title'] and rate(cur, it['title'], artist, track) >= 2
            if ok:
                continue
            v = find_video(ytdlp, it['title'], artist, track)
            print(l['key'], it['rank'], it['title'], '|', it.get('videoTitle') or '-', '->', v and (v['id'], v.get('title'), v.get('duration')), flush=True)
            it['video'] = v['id'] if v else ''
            it['videoTitle'] = v.get('title', '') if v else ''
            it['duration'] = v.get('duration') if v else None
            time.sleep(0.3)
    json.dump(c, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--top', type=int, default=20)
    ap.add_argument('--out', default='public/charts.json')
    ap.add_argument('--yt-dlp', default='yt-dlp')
    ap.add_argument('--fill-missing', action='store_true', help='only look again for songs with no video')
    ap.add_argument('--recheck', action='store_true', help='check every video of an existing chart file, replace the wrong ones')
    a = ap.parse_args()
    if a.recheck:
        return recheck(a.out, a.yt_dlp)
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
            v = find_video(a.yt_dlp, title, artist, track_length(title, artist))
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
