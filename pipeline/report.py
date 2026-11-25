"""Draws a decomposition report: stems as spectrograms and the guide notes over the original's pitch curve."""
import json
import sys
from pathlib import Path

import librosa
import librosa.display
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

out = Path(sys.argv[1])
png = Path(sys.argv[2])
t0, t1 = (float(sys.argv[3]), float(sys.argv[4])) if len(sys.argv) > 4 else (0, None)
extra = [Path(p) for p in sys.argv[5:]]  # optional extra stems to compare, e.g. an older separation
song = json.loads((out / 'song.json').read_text())

stems = [('mix', 'original'), ('instrumental', 'backing track (BS-RoFormer)')]
stems += [(p, p.stem) for p in extra]
stems += [('lead_dry', 'lead vocal, dry (karaoke + de-reverb)')]
fig, axes = plt.subplots(len(stems) + 1, 1, figsize=(15, 2.2 * len(stems) + 4.5),
                         gridspec_kw={'height_ratios': [1] * len(stems) + [2.2]})
for ax, (name, label) in zip(axes, stems):
    path = name if isinstance(name, Path) else out / f'{name}.wav'
    y, sr = librosa.load(str(path), sr=22050, mono=True, offset=t0, duration=None if t1 is None else t1 - t0)
    S = librosa.amplitude_to_db(np.abs(librosa.stft(y, n_fft=2048, hop_length=256)), ref=1.0)
    librosa.display.specshow(S, sr=sr, hop_length=256, y_axis='log', x_axis='time', ax=ax, vmin=-60, vmax=20, cmap='magma')
    ax.set_xticks([]); ax.set_xlabel(''); ax.set_ylabel(''); ax.set_ylim(60, 8000)
    ax.text(0.005, 0.85, label, transform=ax.transAxes, color='white', fontsize=11, weight='bold')

ax = axes[-1]
ax.set_facecolor('#0d0b14')
f0 = song['f0']
tt = np.arange(len(f0['midi'])) * f0['hop']
mm = np.array([np.nan if v is None else v for v in f0['midi']])
sel = (tt >= t0) & (tt <= (t1 or tt[-1]))
colors = {'vibrato': '#ffb347', 'long': '#5df2b6', 'scoop_up': '#7ab8ff', 'fall_in': '#7ab8ff', 'fall_off': '#ff7ab8'}
for n in song['notes']:
    if n['end'] < t0 or (t1 and n['start'] > t1):
        continue
    c = next((colors[k] for k in ('vibrato', 'long', 'scoop_up', 'fall_in', 'fall_off') if k in n['techniques']), '#aaa0ff')
    ax.add_patch(plt.Rectangle((n['start'] - t0, n['midi'] - 0.4), n['end'] - n['start'], 0.8, color=c, alpha=0.55, lw=0))
ax.plot(tt[sel] - t0, mm[sel], color='white', lw=1.1)
for h in song['highlights']:
    if t0 <= h['start'] <= (t1 or 1e9):
        ax.annotate(f"high note {h['peak']}", (h['start'] - t0, max(n['midi'] for n in song['notes']) + 1.2), color='#ff5c8a', fontsize=10)
for b in song['breaths']:
    if t0 <= b <= (t1 or 1e9):
        ax.axvline(b - t0, color='#ffffff33', lw=1, ls=':')
vis = [n['midi'] for n in song['notes'] if n['end'] >= t0 and (not t1 or n['start'] <= t1)] or [60]
lyr = song.get('lyrics')
if lyr:
    # each character under the notes it was given, in the colour of the line
    plt.rcParams['font.sans-serif'] = ['Noto Sans CJK TC', 'Noto Sans CJK JP', 'WenQuanYi Zen Hei', 'WenQuanYi Zen Hei Mono', 'DejaVu Sans']
    for li, line in enumerate(lyr['lines']):
        for c in line['chars']:
            if t0 <= c['start'] <= (t1 or 1e9):
                ax.text((c['start'] + c['end']) / 2 - t0, min(vis) - 2.2, c['text'], ha='center', va='center',
                        fontsize=11, color='#ffd27a' if li % 2 else '#ffffff')
ax.set_ylim(min(vis) - 3.2, max(vis) + 3)
ax.set_xlim(0, (t1 or tt[-1]) - t0)
ax.set_yticks(range(int(min(vis)) - 2, int(max(vis)) + 3))
ax.set_yticklabels([librosa.midi_to_note(m) for m in range(int(min(vis)) - 2, int(max(vis)) + 3)], fontsize=8)
ax.grid(axis='y', color='#ffffff14')
ax.set_xlabel('seconds')
ax.set_title(f"guide notes (SOME) over the original's pitch (RMVPE)   key {song['key']['tonic']} {song['key']['mode']}  "
             f"tempo {song['tempo_bpm']}  range {song['range']['lowest']}-{song['range']['highest']}   "
             "colours: purple plain, blue slide in, pink fall off, green long, orange vibrato; dotted = breath", fontsize=10)
plt.tight_layout()
plt.savefig(png, dpi=110)
print('saved', png)
