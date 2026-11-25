"""
Deep decomposition of one song: the best open models in a chain, then a singing analysis.

  1. vocals / instrumental        BS-RoFormer (ep317, SDR 12.98)
  2. lead vocal / backing vocals  Mel-RoFormer karaoke (aufr33 & viperx)
  3. dry lead (no reverb/echo)    UVR DeEcho-DeReverb (VR arch)
  4. pitch curve, 10 ms           RMVPE (made for singing in mixtures)
  5. notes                        SOME (singing -> notes, continuous pitch)
  6. analysis                     vibrato, slides, long notes, breaths, phrases,
                                  key, range, highest notes, tempo and beats

usage: python pipeline/decompose.py SONG --out DIR --models MODEL_DIR \
           --some SOME_REPO --rmvpe RMVPE_REPO [--force]
Every stage writes its files into DIR and is skipped next time if they exist.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
BS_ROFORMER = 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'
KARAOKE = 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt'
DEREVERB = 'UVR-DeEcho-DeReverb.pth'


def cpu_safe_torch_load() -> None:
    """Third-party checkpoints were saved on a GPU: load them on CPU-only machines too."""
    import torch

    if torch.cuda.is_available() or getattr(torch.load, '_cpu_safe', False):
        return
    orig = torch.load

    def load(*args, **kw):
        kw.setdefault('map_location', 'cpu')
        kw.setdefault('weights_only', False)
        return orig(*args, **kw)

    load._cpu_safe = True  # type: ignore[attr-defined]
    torch.load = load


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


# ---------------------------------------------------------------- separation

def separate(model: str, src: Path, out: Path, models: Path, names: dict[str, str]) -> None:
    """Runs one audio-separator model and renames its stems to names[stem keyword] -> file."""
    if all((out / f).exists() for f in names.values()):
        log(f'skip {model}: done')
        return
    from audio_separator.separator import Separator

    tmp = out / ('_tmp_' + model.split('.')[0])
    tmp.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    sep = Separator(model_file_dir=str(models), output_dir=str(tmp), output_format='WAV')
    sep.load_model(model_filename=model)
    files = sep.separate(str(src))
    log(f'{model}: {time.time() - t0:.0f} s')
    for f in files:
        p = tmp / Path(f).name
        stem = p.name.lower()
        for key, target in names.items():
            if f'({key.lower()})' in stem:
                shutil.move(str(p), out / target)
    shutil.rmtree(tmp, ignore_errors=True)
    missing = [f for f in names.values() if not (out / f).exists()]
    if missing:
        raise RuntimeError(f'{model}: missing stems {missing}; got {files}')


# ---------------------------------------------------------------- pitch

def rmvpe_curve(wav: Path, repo: Path, ckpt: Path) -> tuple[np.ndarray, float]:
    """f0 in Hz every 10 ms (0 = unvoiced)."""
    sys.path.insert(0, str(repo))
    import librosa
    import torch
    from src.inference import RMVPE

    cpu_safe_torch_load()
    y, _ = librosa.load(str(wav), sr=16000, mono=True)
    model = RMVPE(str(ckpt), hop_length=160)
    f0 = model.infer_from_audio(y, sample_rate=16000, device='cpu', thred=0.03)
    sys.path.remove(str(repo))
    return np.asarray(f0, dtype=np.float64), 0.01


# ---------------------------------------------------------------- notes

def some_notes(wav: Path, repo: Path, ckpt: Path) -> list[dict]:
    """Note list [{start, end, midi(float)}] from SOME."""
    import importlib
    import os

    import librosa
    import yaml

    cpu_safe_torch_load()
    cwd = os.getcwd()
    sys.path.insert(0, str(repo))
    os.chdir(repo)
    try:
        import inference
        from utils.slicer2 import Slicer

        with open(ckpt.with_name('config.yaml'), encoding='utf8') as f:
            config = yaml.safe_load(f)
        cls_path = inference.task_inference_mapping[config['task_cls']]
        mod, name = cls_path.rsplit('.', 1)
        infer_cls = getattr(importlib.import_module(mod), name)
        inst = infer_cls(config=config, model_path=ckpt)
        y, _ = librosa.load(str(wav), sr=config['audio_sample_rate'], mono=True)
        chunks = Slicer(sr=config['audio_sample_rate'], max_sil_kept=1000).slice(y)
        results = inst.infer([c['waveform'] for c in chunks])
    finally:
        os.chdir(cwd)
        sys.path.remove(str(repo))
    notes = []
    for c, r in zip(chunks, results):
        t = float(c['offset'])
        for midi, dur, rest in zip(r['note_midi'], r['note_dur'], r['note_rest']):
            if not rest and dur > 0:
                notes.append({'start': round(t, 3), 'end': round(t + float(dur), 3), 'midi': float(midi)})
            t += float(dur)
    return notes


# ---------------------------------------------------------------- analysis

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def note_name(m: float) -> str:
    r = int(round(m))
    return f'{NAMES[r % 12]}{r // 12 - 1}'


def detect_key(notes: list[dict]) -> dict:
    hist = np.zeros(12)
    for n in notes:
        hist[int(round(n['midi'])) % 12] += n['end'] - n['start']
    best = (-2.0, 0, 'major')
    for tonic in range(12):
        for mode, prof in (('major', MAJOR), ('minor', MINOR)):
            c = float(np.corrcoef(hist, np.roll(prof, tonic))[0, 1])
            if c > best[0]:
                best = (c, tonic, mode)
    return {'tonic': NAMES[best[1]], 'mode': best[2], 'confidence': round(best[0], 3)}


def vibrato(cents: np.ndarray, hop: float) -> dict | None:
    """Vibrato on a held note: a 4-8 Hz wobble of at least +-25 cents."""
    if len(cents) * hop < 0.4:
        return None
    k = max(3, int(0.25 / hop))
    trend = np.convolve(cents, np.ones(k) / k, mode='same')  # remove the slow movement
    d = (cents - trend)[k:-k]
    if len(d) * hop < 0.3:
        return None
    sign = np.sign(d)
    crossings = np.count_nonzero(np.diff(sign[sign != 0]))
    rate = crossings / 2 / (len(d) * hop)
    extent = float(np.percentile(np.abs(d), 90))
    if 4 <= rate <= 8.5 and extent >= 25:
        return {'rate_hz': round(rate, 2), 'extent_cents': round(extent)}
    return None


def analyse(notes: list[dict], f0: np.ndarray, hop: float, inst: Path) -> dict:
    import librosa

    midi_curve = np.where(f0 > 0, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440), np.nan)
    out_notes = []
    for n in notes:
        a, b = int(n['start'] / hop), max(int(n['start'] / hop) + 1, int(n['end'] / hop))
        seg = midi_curve[a:b]
        voiced = seg[~np.isnan(seg)]
        note = {**n, 'name': note_name(n['midi']), 'techniques': []}
        if len(voiced) >= 3:
            core = voiced[len(voiced) // 5: len(voiced) - len(voiced) // 5] if len(voiced) >= 10 else voiced
            note['f0_median'] = round(float(np.median(core)), 3)
            dur = n['end'] - n['start']
            # slide into / out of the note
            head = voiced[: max(2, int(0.08 / hop))]
            tail = voiced[-max(2, int(0.08 / hop)):]
            if np.median(head) < note['f0_median'] - 0.8:
                note['techniques'].append('scoop_up')
            elif np.median(head) > note['f0_median'] + 0.8:
                note['techniques'].append('fall_in')
            if dur > 0.25 and np.median(tail) < note['f0_median'] - 1.0:
                note['techniques'].append('fall_off')
            if dur >= 1.0:
                note['techniques'].append('long')
            v = vibrato((voiced - note['f0_median']) * 100, hop)
            if v:
                note['techniques'].append('vibrato')
                note['vibrato'] = v
        out_notes.append(note)

    # phrases (pause >= 0.9 s) and breaths (pause 0.2-0.9 s inside a phrase)
    phrases, breaths = [], []
    for i, n in enumerate(out_notes):
        gap = n['start'] - out_notes[i - 1]['end'] if i else math.inf
        if gap >= 0.9:
            phrases.append({'start': n['start'], 'end': n['end'], 'notes': [i]})
        else:
            phrases[-1]['end'] = n['end']
            phrases[-1]['notes'].append(i)
            if gap >= 0.2:
                breaths.append(round(out_notes[i - 1]['end'], 3))

    mids = np.array([n['midi'] for n in out_notes]) if out_notes else np.array([60.0])
    durs = np.array([n['end'] - n['start'] for n in out_notes]) if out_notes else np.array([1.0])
    top = float(np.max(mids[durs >= 0.15])) if np.any(durs >= 0.15) else float(np.max(mids))
    highlights = []
    for i, n in enumerate(out_notes):
        if n['midi'] >= top - 1 and n['end'] - n['start'] >= 0.15:
            if highlights and n['start'] - highlights[-1]['end'] < 2:
                highlights[-1]['end'] = n['end']
                highlights[-1]['notes'].append(i)
            else:
                highlights.append({'type': 'high_note', 'start': n['start'], 'end': n['end'], 'peak': n['name'], 'notes': [i]})

    y, _ = librosa.load(str(inst), sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=22050, units='time')
    tempo = float(np.atleast_1d(tempo)[0])

    counts: dict[str, int] = {}
    for n in out_notes:
        for t in n['techniques']:
            counts[t] = counts.get(t, 0) + 1
    return {
        'notes': out_notes,
        'phrases': phrases,
        'breaths': breaths,
        'highlights': highlights,
        'key': detect_key(out_notes) if out_notes else None,
        'range': {
            'lowest': note_name(float(np.min(mids))),
            'highest': note_name(float(np.max(mids))),
            'comfortable': [note_name(float(np.percentile(mids, 10))), note_name(float(np.percentile(mids, 90)))],
        },
        'technique_counts': counts,
        'tempo_bpm': round(tempo, 1),
        'beats': [round(float(b), 3) for b in beats],
        'f0': {'hop': hop, 'midi': [None if np.isnan(v) else round(float(v), 2) for v in midi_curve]},
    }


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('song', type=Path)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--models', type=Path, required=True)
    ap.add_argument('--some', type=Path, required=True, help='clone of openvpi/SOME')
    ap.add_argument('--some-ckpt', type=Path, help='defaults to MODELS/some/*/model_ckpt*.ckpt')
    ap.add_argument('--rmvpe', type=Path, required=True, help='clone of yxlllc/RMVPE')
    ap.add_argument('--rmvpe-ckpt', type=Path, help='defaults to MODELS/rmvpe/model.pt')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    out = a.out
    if a.force and out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)
    t_all = time.time()
    timings = {}

    mix = out / 'mix.wav'
    if not mix.exists():
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(a.song), '-ar', str(SR), '-ac', '2', str(mix)], check=True)

    t = time.time()
    separate(BS_ROFORMER, mix, out, a.models, {'Vocals': 'vocals.wav', 'Instrumental': 'instrumental.wav'})
    timings['1_vocals_instrumental'] = round(time.time() - t)
    t = time.time()
    separate(KARAOKE, out / 'vocals.wav', out, a.models, {'Vocals': 'lead.wav', 'Instrumental': 'backing.wav'})
    timings['2_lead_backing'] = round(time.time() - t)
    t = time.time()
    separate(DEREVERB, out / 'lead.wav', out, a.models, {'No Reverb': 'lead_dry.wav', 'Reverb': 'lead_reverb.wav'})
    timings['3_dereverb'] = round(time.time() - t)

    t = time.time()
    f0, hop = rmvpe_curve(out / 'lead_dry.wav', a.rmvpe, a.rmvpe_ckpt or a.models / 'rmvpe' / 'model.pt')
    timings['4_pitch'] = round(time.time() - t)
    log(f'pitch: {np.count_nonzero(f0)} voiced frames of {len(f0)}')

    t = time.time()
    ckpt = a.some_ckpt or next((a.models / 'some').glob('*/model_ckpt*.ckpt'))
    notes = some_notes(out / 'lead_dry.wav', a.some, ckpt)
    timings['5_notes'] = round(time.time() - t)
    log(f'notes: {len(notes)}')

    t = time.time()
    result = analyse(notes, f0, hop, out / 'instrumental.wav')
    timings['6_analysis'] = round(time.time() - t)
    info = sf.info(str(mix))
    result = {
        'version': 1,
        'duration': round(info.duration, 3),
        'stems': {k: f'{k}.wav' for k in ('instrumental', 'vocals', 'lead', 'backing', 'lead_dry')},
        'models': {'vocals': BS_ROFORMER, 'lead_backing': KARAOKE, 'dereverb': DEREVERB, 'pitch': 'RMVPE', 'notes': ckpt.parent.name},
        'timings_s': timings,
        **result,
    }
    (out / 'song.json').write_text(json.dumps(result, ensure_ascii=False))
    log(f'done in {time.time() - t_all:.0f} s -> {out / "song.json"}')
    log(f'key {result["key"]}, range {result["range"]}, tempo {result["tempo_bpm"]}, techniques {result["technique_counts"]}')


if __name__ == '__main__':
    main()
