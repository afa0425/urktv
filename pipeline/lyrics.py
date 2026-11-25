"""
Puts scraped lyrics (LRC) on the song's own timeline and down to each character.

The scraped timings usually follow the studio recording; an MV adds an intro or a story,
so the whole file is shifted. We find that shift by matching the LRC line starts against
the note onsets of the separated lead vocal, then snap each line to its notes and spread
its characters over them (one character per note when the counts match).

usage: python pipeline/lyrics.py OUT_DIR lyrics.lrc [--window START END] [--trad]
Writes the result into OUT_DIR/song.json under "lyrics".
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import numpy as np

STAMP = re.compile(r'\[(\d+):(\d+(?:\.\d+)?)\]')
CREDIT = re.compile(r'^(.*-.*|词|詞|曲|编曲|編曲|作词|作曲|制作|製作|lyrics|music)\s*[:：]', re.I)
SINGABLE = re.compile(r'[㐀-鿿぀-ヿA-Za-z0-9가-힯]')


def parse_lrc(text: str) -> list[tuple[float, str]]:
    out = []
    for row in text.splitlines():
        stamps = STAMP.findall(row)
        words = STAMP.sub('', row).strip()
        if not stamps or not words or CREDIT.match(words) or ' - ' in words:
            continue
        for m, s in stamps:
            out.append((int(m) * 60 + float(s), words))
    return sorted(out)


def units(text: str) -> list[str]:
    """What gets one note each: a CJK character, or a whole Latin/number word."""
    return re.findall(r'[A-Za-z0-9\']+|[㐀-鿿぀-ヿ가-힯]|[㄀-ㄯ]+', text)


def find_offset(line_t: np.ndarray, onsets: np.ndarray, lo: float = -90, hi: float = 90) -> tuple[float, float]:
    """Shift that puts the most line starts right on a note onset (score in 0..1)."""
    best = (0.0, -1.0)
    sigma = 0.12
    for off in np.arange(lo, hi, 0.01):
        t = line_t + off
        idx = np.clip(np.searchsorted(onsets, t), 1, len(onsets) - 1)
        d = np.minimum(np.abs(onsets[idx] - t), np.abs(onsets[idx - 1] - t))
        score = float(np.mean(np.exp(-(d ** 2) / (2 * sigma ** 2))))
        if score > best[1]:
            best = (float(off), score)
    return best


def align(lines: list[tuple[float, str]], notes: list[dict], window: tuple[float, float] | None) -> dict:
    onsets = np.array([n['start'] for n in notes])
    lt = np.array([t for t, _ in lines])
    # coarse search over the whole range, then only lines that land inside the analysed window count
    lo, hi = -90.0, 90.0
    if window:
        w0, w1 = window
        # keep shifts that put at least 3 lines inside the window
        offs = [o for o in np.arange(lo, hi, 0.5) if np.sum((lt + o >= w0) & (lt + o <= w1)) >= 3]
        cands = []
        for o in offs:
            sel = (lt + o >= w0) & (lt + o <= w1 - 1)
            off, sc = find_offset(lt[sel], onsets, o - 0.5, o + 0.5)
            cands.append((sc, off))
        score, offset = max(cands)
    else:
        offset, score = find_offset(lt, onsets, lo, hi)

    ends = np.array([n['end'] for n in notes])
    prev_end = np.concatenate([[-10], ends[:-1]])
    after_breath = onsets - prev_end >= 0.2
    keep = []
    for i, (t, text) in enumerate(lines):
        start = t + offset
        nxt = lines[i + 1][0] + offset if i + 1 < len(lines) else start + 8
        if window and not (window[0] - 1 <= start <= window[1]):
            continue
        keep.append((start, nxt, text))

    # Dynamic programming over where each line starts. A line should start near its scraped time
    # (timings run early more often than late), preferably right after a breath, and the notes
    # between two line starts should number about the characters of the line (one per syllable).
    def time_cost(j: int, t: float) -> float:
        d = onsets[j] - t
        return (abs(d) if d >= 0 else 1.5 * abs(d)) + (0 if after_breath[j] else 0.6)

    def count_cost(n_notes: int, n_units: int) -> float:
        if n_units == 0:
            return 0.0
        return 0.35 * max(0, n_notes - n_units) + 0.7 * max(0, n_units - n_notes)

    cand = [[j for j in range(len(notes)) if t - 1.5 <= onsets[j] <= t + 3.0] or
            [int(np.argmin(np.abs(onsets - t)))] for t, _, _ in keep]
    cost = [{j: time_cost(j, keep[0][0]) for j in cand[0]}]
    back: list[dict[int, int]] = [{}]
    for i in range(1, len(keep)):
        n_prev = len(units(keep[i - 1][2]))
        row, brow = {}, {}
        for j in cand[i]:
            best = None
            for jp, cp in cost[i - 1].items():
                if jp >= j:
                    continue
                c = cp + count_cost(j - jp, n_prev) + time_cost(j, keep[i][0])
                if best is None or c < best[0]:
                    best = (c, jp)
            if best:
                row[j], brow[j] = best
        if not row:  # no consistent order: fall back to the nearest onset
            j = cand[i][0]
            row[j], brow[j] = min(cost[i - 1].values()), min(cost[i - 1], key=cost[i - 1].get)
        cost.append(row)
        back.append(brow)
    j = min(cost[-1], key=cost[-1].get)
    line_starts = [j]
    for i in range(len(keep) - 1, 0, -1):
        j = back[i][j]
        line_starts.append(j)
    line_starts.reverse()
    out_lines = [{'text': text, '_start': start, '_nxt': nxt} for start, nxt, text in keep]

    # second pass: each line owns the notes from its start note up to the next line's start note
    final = []
    for k, (l, j0) in enumerate(zip(out_lines, line_starts)):
        j1 = line_starts[k + 1] if k + 1 < len(line_starts) else len(notes)
        line_notes = notes[j0:max(j0, j1)]
        text, start, nxt = l['text'], l['_start'], l['_nxt']
        us = units(text)
        chars = []
        if line_notes and us:
            k = len(line_notes)
            # one unit per note when the counts match; otherwise spread the units evenly over the notes
            for u_i, u in enumerate(us):
                a = int(round(u_i * k / len(us)))
                b = max(a + 1, int(round((u_i + 1) * k / len(us))))
                seg = line_notes[a:b] or [line_notes[-1]]
                chars.append({'text': u, 'start': seg[0]['start'], 'end': seg[-1]['end']})
            start = line_notes[0]['start']
            end = line_notes[-1]['end']
        else:
            end = min(nxt, start + 6)
        final.append({'start': round(start, 3), 'end': round(end, 3), 'text': text,
                      'notes_matched': len(line_notes), 'units': len(us), 'chars': chars})
    return {'offset_s': round(offset, 2), 'match_score': round(score, 3), 'lines': final}


def transcribe(wav: Path, prompt: str) -> list[tuple[float, float, str]]:
    """Word timings of the dry lead vocal (faster-whisper). Only used as timing anchors."""
    import librosa
    from faster_whisper import WhisperModel

    m = WhisperModel('large-v3-turbo', device='auto', compute_type='int8')
    y, _ = librosa.load(str(wav), sr=16000, mono=True)
    segs, _ = m.transcribe(y, language='zh', word_timestamps=True, vad_filter=False, initial_prompt=prompt)
    return [(w.start, w.end, w.word) for s in segs for w in s.words]


def align_with_asr(lines: list[tuple[float, str]], notes: list[dict], words: list, window) -> dict:
    """
    Anchors the scraped lyrics on what the recogniser heard: characters are matched in order
    (difflib), matched characters take the recognised time (snapped to a note onset), the rest are
    interpolated between their matched neighbours. The lyric text itself is never changed.
    """
    import difflib

    # recognised characters with times (a multi-character word shares its time span evenly)
    asr = []
    for a, b, w in words:
        us = units(w)
        for k, u in enumerate(us):
            asr.append((a + (b - a) * k / len(us), u))
    # lyric characters, with the line they belong to
    lyr = []
    for li, (t, text) in enumerate(lines):
        for u in units(text):
            lyr.append((li, t, u))
    # compare in one script so variants (颳/刮, 裡/裏…) and Traditional/Simplified still match
    try:
        import opencc

        norm = opencc.OpenCC('t2s').convert
    except ImportError:
        norm = lambda x: x  # noqa: E731
    sm = difflib.SequenceMatcher(a=[norm(u) for _, _, u in lyr], b=[norm(u) for _, u in asr], autojunk=False)
    anchor: dict[int, float] = {}
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            anchor[blk.a + k] = asr[blk.b + k][0]
    if not anchor:
        raise RuntimeError('no lyric characters matched the recognised vocal')
    # global shift between the scraped timeline and the song (median over matched characters)
    offset = float(np.median([anchor[i] - lyr[i][1] for i in anchor]))
    onsets = np.array([n['start'] for n in notes])

    def snap(t: float) -> float:
        j = int(np.argmin(np.abs(onsets - t)))
        return float(onsets[j]) if abs(onsets[j] - t) <= 0.25 else t

    times = [None] * len(lyr)
    for i, t in anchor.items():
        times[i] = snap(t)
    known = [i for i in range(len(lyr)) if times[i] is not None]
    for i in range(len(lyr)):
        if times[i] is not None:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        if prev is not None and nxt is not None:
            times[i] = times[prev] + (times[nxt] - times[prev]) * (i - prev) / (nxt - prev)
        elif prev is not None:
            times[i] = times[prev] + 0.3 * (i - prev)
        else:
            times[i] = lyr[i][1] + offset
    # lines from their characters
    out = []
    for li, (t, text) in enumerate(lines):
        idx = [i for i in range(len(lyr)) if lyr[i][0] == li]
        if not idx:
            continue
        start = times[idx[0]]
        if window and not (window[0] - 1 <= start <= window[1]):
            continue
        heard = sum(i in anchor for i in idx)
        if heard < max(2, 0.25 * len(idx)):
            continue  # (almost) nothing of this line was heard: it is outside the analysed audio
        chars = []
        for k, i in enumerate(idx):
            nxt_t = times[idx[k + 1]] if k + 1 < len(idx) else None
            # a character lasts until the next one starts, or to the end of the note it starts on
            j = int(np.argmin(np.abs(onsets - times[i])))
            end = nxt_t if nxt_t is not None else max(times[i] + 0.2, notes[j]['end'])
            chars.append({'text': lyr[i][2], 'start': round(times[i], 3), 'end': round(end, 3), 'heard': i in anchor})
        out.append({'start': round(start, 3), 'end': chars[-1]['end'], 'text': text,
                    'matched': sum(c['heard'] for c in chars), 'units': len(chars), 'chars': chars})
    return {'offset_s': round(offset, 2), 'match_score': round(len(anchor) / len(lyr), 3), 'method': 'asr', 'lines': out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('lrc', type=Path)
    ap.add_argument('--window', type=float, nargs=2, help='only this part of the song was analysed (seconds)')
    ap.add_argument('--shift', type=float, default=0, help='song.json times start this many seconds into the lrc timeline')
    ap.add_argument('--trad', action='store_true', help='convert to Traditional Chinese (Taiwan)')
    ap.add_argument('--asr', type=Path, help='word timings JSON from a previous run (else transcribed now)')
    ap.add_argument('--no-asr', action='store_true', help='only match line starts against note onsets')
    ap.add_argument('--prompt', default='', help='hint for the recogniser, e.g. the song title')
    a = ap.parse_args()
    song = json.loads((a.out / 'song.json').read_text())
    text = a.lrc.read_text(encoding='utf8')
    if a.trad:
        import opencc

        text = opencc.OpenCC('s2twp').convert(text)
    lines = [(t - a.shift, s) for t, s in parse_lrc(text)]
    window = tuple(a.window) if a.window else None
    if a.no_asr:
        res = align(lines, song['notes'], window)
    else:
        if a.asr and a.asr.exists():
            words = json.loads(a.asr.read_text())
        else:
            words = transcribe(a.out / 'lead_dry.wav', a.prompt)
            (a.out / 'asr_words.json').write_text(json.dumps(words, ensure_ascii=False))
        if a.trad:
            import opencc

            cc = opencc.OpenCC('s2twp')
            words = [(x, y, cc.convert(w)) for x, y, w in words]
        res = align_with_asr(lines, song['notes'], words, window)
    song['lyrics'] = res
    (a.out / 'song.json').write_text(json.dumps(song, ensure_ascii=False))
    print(f"offset {res['offset_s']} s, match {res['match_score']}, {len(res['lines'])} lines")
    for l in res['lines']:
        k = 'matched' if 'matched' in l else 'notes_matched'
        print(f"{l['start']:7.2f}-{l['end']:7.2f}  {k} {l[k]:2d} / chars {l['units']:2d}  {l['text']}")


if __name__ == '__main__':
    main()
