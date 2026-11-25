import { useEffect, useMemo, useRef, useState } from 'react';
import { MicPitch } from '../audio/mic';
import { midiName } from '../audio/pitch';
import { detectKind, lineAt, parseChart, type Chart } from '../core/chart';
import { foldNear, FreeScorer, GuideScorer, type Difficulty, type Scorer, type ScoreResult } from '../core/score';
import { charts, DEMO_ID, renameSong, settings, useStore, type Song } from '../core/store';
import { demoChart, LocalTransport, SynthTransport, toUltraStar, YouTubeTransport, type Transport } from '../core/transport';
import { runWorker } from '../separate/client';
import { fromInt16, getLocal, isLocal, type LocalSong } from '../separate/db';
import { useT, type I18nKey } from '../i18n';
import { drawLane, nearestNote, type LaneState, type TracePoint } from './lane';

interface Props {
  song: Song;
  nextTitle?: string;
  onExit(): void;
  onDone(result: ScoreResult, song: Song): void;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Stage({ song, nextTitle, onExit, onDone }: Props) {
  const t = useT();
  const cfg = useStore(settings);
  const saved = useStore(charts)[song.id];
  const isDemo = song.id === DEMO_ID;
  const own = isLocal(song.id);

  const [phase, setPhase] = useState<'ready' | 'live'>('ready');
  const [run, setRun] = useState(0); // bump to rebuild the player and start over
  const [title, setTitle] = useState(song.title);
  const [micErr, setMicErr] = useState<I18nKey | null>(null);
  const [ytErr, setYtErr] = useState<I18nKey | null>(null);
  const [chartErr, setChartErr] = useState(false);
  const [hud, setHud] = useState({ score: 0, note: '', level: 0, time: 0, dur: 0, playing: false });
  // your own song: tracks from this browser's storage
  const [local, setLocal] = useState<LocalSong | null>(null);
  const [localErr, setLocalErr] = useState(false);
  const [key, setKey] = useState(0);
  const [keyBusy, setKeyBusy] = useState(false);
  const [vocal, setVocal] = useState(0);
  const base = useRef<{ inst: Float32Array[]; voc: Float32Array[] } | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const transport = useRef<Transport | null>(null);
  const mic = useRef(new MicPitch());
  const scorer = useRef<Scorer>(new FreeScorer());
  const trace = useRef<TracePoint[]>([]);
  const lane = useRef<LaneState>({ center: 60 });

  const chart: Chart | null = useMemo(() => {
    if (isDemo) return demoChart();
    if (own) return local ? { title: local.title, notes: local.notes, lines: local.lines, hasPitch: local.notes.length > 0 } : null;
    if (!saved) return null;
    try {
      return parseChart(saved.raw, saved.kind);
    } catch {
      return null;
    }
  }, [isDemo, own, local, saved?.raw, saved?.kind]);
  const guide = !!chart?.hasPitch;
  const transpose = own ? key : saved?.transpose ?? 0;

  // Values the animation loop reads without restarting.
  const live = useRef({ chart, offset: 0, transpose: 0, latency: 0, title });
  live.current = {
    chart,
    offset: own ? 0 : (saved?.offsetMs ?? 0) / 1000,
    transpose,
    latency: cfg.latencyMs / 1000,
    title,
  };

  useEffect(() => {
    const s = guide ? new GuideScorer(chart!, cfg.difficulty) : new FreeScorer();
    if (s instanceof GuideScorer) s.transpose = transpose;
    scorer.current = s;
    trace.current = [];
  }, [chart, guide, cfg.difficulty, run]);
  useEffect(() => {
    if (scorer.current instanceof GuideScorer) scorer.current.transpose = transpose;
  }, [transpose]);

  // load your own song's tracks
  useEffect(() => {
    if (!own) return;
    let off = false;
    getLocal(song.id)
      .then((s) => {
        if (off) return;
        if (!s) return setLocalErr(true);
        base.current = { inst: fromInt16(s.inst, 2), voc: fromInt16(s.voc, 1) };
        setTitle(s.title);
        setLocal(s);
      })
      .catch(() => !off && setLocalErr(true));
    return () => {
      off = true;
    };
  }, [own, song.id]);

  // the player
  useEffect(() => {
    setYtErr(null);
    const host = hostRef.current!;
    if (own && !local) return;
    const tr: Transport = own
      ? new LocalTransport(base.current!.inst, base.current!.voc, vocal)
      : isDemo
      ? new SynthTransport(demoChart(), () => settings.get().guideVolume)
      : new YouTubeTransport(host, song.id, {
          onTitle: (name) => {
            setTitle(name);
            renameSong(song.id, name);
          },
          onError: (code) =>
            setYtErr(code === 101 || code === 150 ? 'stage.yt.embed' : code === -1 ? 'stage.yt.api' : 'stage.yt.gone'),
        });
    transport.current = tr;
    return () => {
      tr.destroy();
      if (!isDemo && !own) host.replaceChildren();
      transport.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, isDemo, own, local, run]);

  const changeVocal = (v: number) => {
    setVocal(v);
    if (transport.current instanceof LocalTransport) transport.current.setVocal(v);
  };

  /** Key change for your own song: re-pitch the backing and the guide vocal from the originals. */
  const changeKey = async (k: number) => {
    if (!base.current || keyBusy || k === key) return;
    setKeyBusy(true);
    try {
      const b = base.current;
      const chans = [...b.inst, ...b.voc].map((c) => c.slice());
      const out = await runWorker({ type: 'shift', channels: chans, semitones: k }, undefined, chans.map((c) => c.buffer)).done;
      if (out.type === 'shifted' && transport.current instanceof LocalTransport) {
        transport.current.replace(out.channels.slice(0, 2), out.channels.slice(2));
        setKey(k);
      }
    } catch {
      /* keep the current key */
    } finally {
      setKeyBusy(false);
    }
  };

  const exportChart = () => {
    if (!local) return;
    const blob = new Blob([toUltraStar(local.title, local.notes)], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${local.title}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  useEffect(() => () => mic.current.stop(), []);

  // keep the canvas sharp at any size
  useEffect(() => {
    const cv = canvasRef.current!;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(cv.clientWidth * dpr);
      cv.height = Math.round(cv.clientHeight * dpr);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    return () => ro.disconnect();
  }, []);

  const finish = () => {
    const tr = transport.current;
    tr?.pause();
    mic.current.stop();
    onDone(scorer.current.result(), { id: song.id, title: live.current.title });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // the loop: read the mic, score, draw
  useEffect(() => {
    if (phase !== 'live') return;
    let raf = 0;
    let prev = performance.now();
    let lastHud = 0;
    let done = false;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const tr = transport.current;
      const cv = canvasRef.current;
      if (!tr || !cv) return;
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      const L = live.current;
      const frame = mic.current.read(now);
      const time = tr.time();
      const playing = tr.playing();
      const tc = time - L.offset - L.latency; // chart time the voice we hear now belongs to
      const notes = L.chart?.hasPitch ? L.chart.notes : null;

      if (playing) {
        const tp = trace.current;
        if (tp.length && tc < tp[tp.length - 1].t - 0.5) tp.length = 0; // jumped back
        const r = scorer.current.push(tc, frame.midi, dt);
        let shown = frame.midi;
        if (shown !== null && notes) {
          const target = nearestNote(notes, tc);
          if (target) shown = foldNear(shown, target.midi + L.transpose);
        }
        tp.push({ t: tc, midi: shown, hit: r.hit });
        while (tp.length && tp[0].t < tc - 10) tp.shift();
      }

      const ctx = cv.getContext('2d')!;
      const dpr = cv.width / Math.max(1, cv.clientWidth);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLane(ctx, cv.clientWidth, cv.clientHeight, lane.current, {
        now: tc,
        trace: trace.current,
        notes,
        transpose: L.transpose,
        live: frame.midi,
      });

      if (now - lastHud > 120) {
        lastHud = now;
        setHud({
          score: scorer.current.live(),
          note: frame.midi !== null ? midiName(frame.midi) : '',
          level: frame.level,
          time,
          dur: tr.duration(),
          playing,
        });
      }
      if (tr.ended() && !done) {
        done = true;
        finishRef.current();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const start = async (withMic: boolean) => {
    setMicErr(null);
    if (withMic) {
      if (!navigator.mediaDevices?.getUserMedia) setMicErr('stage.mic.insecure');
      else {
        try {
          await mic.current.start(cfg.micId || undefined);
        } catch (e: any) {
          const name = e?.name;
          if (name === 'OverconstrainedError' && cfg.micId) {
            // the remembered microphone is unplugged: fall back to the default one
            settings.set((s) => ({ ...s, micId: '' }));
            try {
              await mic.current.start();
            } catch {
              setMicErr('stage.mic.none');
            }
          } else setMicErr(name === 'NotFoundError' ? 'stage.mic.none' : 'stage.mic.denied');
        }
      }
    }
    transport.current?.play();
    setPhase('live');
  };

  const restart = () => {
    setPhase('ready');
    setHud((h) => ({ ...h, score: 0, time: 0, playing: false }));
    setRun((r) => r + 1);
  };

  const importChart = async (file: File | undefined) => {
    setChartErr(false);
    if (!file) return;
    try {
      if (file.size > 600_000) throw new Error('too big');
      const raw = await file.text();
      const kind = detectKind(raw);
      if (!kind) throw new Error('format');
      parseChart(raw, kind);
      charts.set((c) => ({ ...c, [song.id]: { raw, kind, offsetMs: 0, transpose: 0 } }));
    } catch {
      setChartErr(true);
    }
    if (fileRef.current) fileRef.current.value = '';
  };
  const patchChart = (p: { offsetMs?: number; transpose?: number }) =>
    charts.set((c) => (c[song.id] ? { ...c, [song.id]: { ...c[song.id], ...p } } : c));
  const removeChart = () =>
    charts.set((c) => {
      const { [song.id]: _gone, ...rest } = c;
      return rest;
    });
  const setCfg = (p: Partial<typeof cfg>) => settings.set((s) => ({ ...s, ...p }));

  // lyrics
  const tl = hud.time - live.current.offset;
  const li = chart ? lineAt(chart.lines, tl) : -1;
  const cur = li >= 0 ? chart!.lines[li] : null;
  const nxt = li >= 0 ? chart!.lines[li + 1] : null;

  return (
    <div className="stage">
      <header className="stage-top">
        <button className="btn ghost" onClick={onExit}>
          ← {t('stage.back')}
        </button>
        <h1 className="stage-title">{isDemo ? t('stage.demoTitle') : title}</h1>
        <span className={'chip ' + (guide ? 'chip-on' : '')}>{t(guide ? 'stage.mode.guide' : 'stage.mode.free')}</span>
      </header>

      <div className="stage-grid">
        <section className="stage-main">
          <div className={'video ' + (isDemo || own ? 'video-demo' : '')}>
            <div className="video-host" ref={hostRef} />
            {isDemo && <div className="demo-art">♪ Do · Re · Mi · Fa · Sol</div>}
            {own && <div className="demo-art">♪ {title}</div>}
            {ytErr && <div className="overlay error">{t(ytErr)}</div>}
            {localErr && <div className="overlay error">{t('mine.missing')}</div>}
            {own && !local && !localErr && <div className="overlay">{t('mine.loading')}</div>}
            {phase === 'ready' && !ytErr && (!own || local) && (
              <div className="overlay">
                <button className="btn primary big" onClick={() => start(true)}>
                  🎤 {t('stage.start')}
                </button>
                <p className="muted">{t('stage.startHint')}</p>
                <button className="btn link" onClick={() => start(false)}>
                  {t('stage.noMicStart')}
                </button>
              </div>
            )}
          </div>

          <div className="lyrics" aria-live="off">
            {cur ? (
              <>
                <p className="lyric-cur">
                  {cur.parts.length
                    ? cur.parts.map((p, k) => (
                        <span key={k} className={tl >= p.end ? 'sung' : tl >= p.start ? 'singing' : ''}>
                          {p.text}
                        </span>
                      ))
                    : cur.text}
                </p>
                <p className="lyric-next">{nxt?.text ?? ''}</p>
              </>
            ) : (
              <p className="lyric-next">{chart ? '♪' : ''}</p>
            )}
          </div>

          <div className="lane-wrap">
            <canvas ref={canvasRef} className="lane" />
          </div>
          {micErr && <p className="notice warn">{t(micErr)}</p>}
          {!guide && <p className="notice">{t('stage.mode.free.hint')}</p>}
        </section>

        <aside className="stage-side">
          <div className="card scorebox">
            <div className="label">{t('stage.score')}</div>
            <div className="score-num">{Math.round(hud.score)}</div>
            <div className="meter" aria-hidden="true">
              <i style={{ width: `${Math.round(hud.level * 100)}%` }} />
            </div>
            <div className="row between">
              <span className="label">{t('stage.note')}</span>
              <strong className="note-name">{hud.note || '–'}</strong>
            </div>
            <div className="label time">
              {fmt(hud.time)} / {fmt(hud.dur)}
            </div>
          </div>

          {phase === 'live' && (
            <div className="card col">
              <button
                className="btn"
                onClick={() => (hud.playing ? transport.current?.pause() : transport.current?.play())}
              >
                {hud.playing ? t('stage.pause') : t('stage.resume')}
              </button>
              <button className="btn" onClick={restart}>
                {t('stage.restart')}
              </button>
              <button className="btn primary" onClick={finish}>
                {t('stage.finish')}
              </button>
              {nextTitle && <p className="muted small">{t('queue.next', { title: nextTitle })}</p>}
            </div>
          )}

          <div className="card col">
            <label className="field">
              <span>{t('stage.difficulty')}</span>
              <select value={cfg.difficulty} onChange={(e) => setCfg({ difficulty: e.target.value as Difficulty })}>
                <option value="easy">{t('stage.difficulty.easy')}</option>
                <option value="normal">{t('stage.difficulty.normal')}</option>
                <option value="hard">{t('stage.difficulty.hard')}</option>
              </select>
            </label>
            <label className="field">
              <span>
                {t('stage.latency')} · {cfg.latencyMs} ms
              </span>
              <input
                type="range"
                min={0}
                max={300}
                step={10}
                value={cfg.latencyMs}
                onChange={(e) => setCfg({ latencyMs: Number(e.target.value) })}
              />
            </label>
            {isDemo && (
              <label className="field">
                <span>{t('stage.guideVol')}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={cfg.guideVolume}
                  onChange={(e) => setCfg({ guideVolume: Number(e.target.value) })}
                />
              </label>
            )}
          </div>

          {own && local && (
            <div className="card col">
              <label className="field">
                <span>
                  {t('mine.vocal')} · {Math.round(vocal * 100)}%
                </span>
                <input type="range" min={0} max={1} step={0.05} value={vocal} onChange={(e) => changeVocal(Number(e.target.value))} />
              </label>
              <div className="field">
                <span>
                  {t('stage.key')} · {key > 0 ? '+' : ''}
                  {key} {t('common.semitone')}
                  {keyBusy ? ' · ' + t('mine.keyBusy') : ''}
                </span>
                <div className="row">
                  <button className="btn small" disabled={keyBusy || key <= -6} onClick={() => changeKey(key - 1)}>
                    ♭ −1
                  </button>
                  <button className="btn small" disabled={keyBusy || key === 0} onClick={() => changeKey(0)}>
                    0
                  </button>
                  <button className="btn small" disabled={keyBusy || key >= 6} onClick={() => changeKey(key + 1)}>
                    ♯ +1
                  </button>
                </div>
              </div>
              <button className="btn link" onClick={exportChart}>
                {t('mine.export')}
              </button>
            </div>
          )}

          {!isDemo && !own && (
            <div className="card col">
              <div className="label">{t('stage.chart')}</div>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.lrc,text/plain"
                hidden
                onChange={(e) => importChart(e.target.files?.[0])}
              />
              <button className="btn" onClick={() => fileRef.current?.click()}>
                {t('stage.chart.import')}
              </button>
              {chartErr && <p className="notice warn">{t('stage.chart.bad')}</p>}
              {saved && chart && !chart.hasPitch && <p className="muted small">{t('stage.chart.lyricsOnly')}</p>}
              {saved && (
                <>
                  <label className="field">
                    <span>
                      {t('stage.offset')} · {(saved.offsetMs / 1000).toFixed(2)} {t('common.sec')}
                    </span>
                    <input
                      type="range"
                      min={-10000}
                      max={10000}
                      step={50}
                      value={saved.offsetMs}
                      onChange={(e) => patchChart({ offsetMs: Number(e.target.value) })}
                    />
                  </label>
                  {guide && (
                    <label className="field">
                      <span>
                        {t('stage.key')} · {saved.transpose > 0 ? '+' : ''}
                        {saved.transpose} {t('common.semitone')}
                      </span>
                      <input
                        type="range"
                        min={-6}
                        max={6}
                        step={1}
                        value={saved.transpose}
                        onChange={(e) => patchChart({ transpose: Number(e.target.value) })}
                      />
                    </label>
                  )}
                  <button className="btn link danger" onClick={removeChart}>
                    {t('stage.chart.remove')}
                  </button>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
