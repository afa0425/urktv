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

    out_lines = []
    for i, (t, text) in enumerate(lines):
        start = t + offset
        nxt = lines[i + 1][0] + offset if i + 1 < len(lines) else start + 8
        if window and not (window[0] - 1 <= start <= window[1]):
            continue
        # notes belonging to this line: from the onset nearest to its start until the next line
        j0 = int(np.argmin(np.abs(onsets - start)))
        if abs(onsets[j0] - start) > 0.5:
            j0 = int(np.searchsorted(onsets, start))
        line_notes = [n for n in notes[j0:] if n['start'] < nxt - 0.15]
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
        out_lines.append({'start': round(start, 3), 'end': round(end, 3), 'text': text,
                          'notes_matched': len(line_notes), 'units': len(us), 'chars': chars})
    return {'offset_s': round(offset, 2), 'match_score': round(score, 3), 'lines': out_lines}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('out', type=Path)
    ap.add_argument('lrc', type=Path)
    ap.add_argument('--window', type=float, nargs=2, help='only this part of the song was analysed (seconds)')
    ap.add_argument('--shift', type=float, default=0, help='song.json times start this many seconds into the lrc timeline')
    ap.add_argument('--trad', action='store_true', help='convert to Traditional Chinese (Taiwan)')
    a = ap.parse_args()
    song = json.loads((a.out / 'song.json').read_text())
    text = a.lrc.read_text(encoding='utf8')
    if a.trad:
        import opencc

        text = opencc.OpenCC('s2twp').convert(text)
    lines = [(t - a.shift, s) for t, s in parse_lrc(text)]
    res = align(lines, song['notes'], tuple(a.window) if a.window else None)
    song['lyrics'] = res
    (a.out / 'song.json').write_text(json.dumps(song, ensure_ascii=False))
    print(f"offset {res['offset_s']} s, match {res['match_score']}, {len(res['lines'])} lines")
    for l in res['lines']:
        print(f"{l['start']:7.2f}-{l['end']:7.2f}  notes {l['notes_matched']:2d} / chars {l['units']:2d}  {l['text']}")


if __name__ == '__main__':
    main()
