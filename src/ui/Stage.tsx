import { useEffect, useMemo, useRef, useState } from 'react';
import { MicPitch } from '../audio/mic';
import { midiName } from '../audio/pitch';
import { detectKind, lineAt, parseChart, type Chart } from '../core/chart';
import { foldNear, FreeScorer, GuideScorer, type Difficulty, type ScoreExtras, type Scorer, type ScoreResult } from '../core/score';
import { charts, DEMO_ID, renameSong, settings, useStore, type Song } from '../core/store';
import { demoChart, DualTransport, LocalTransport, SynthTransport, toUltraStar, YouTubeTransport, type Transport } from '../core/transport';
import { extPost, LEAD, useExtension } from '../core/extension';
import { MODELS } from '../separate/mdx';
import { MODEL_BASE, ORT_BASE } from '../separate/client';
import { runWorker } from '../separate/client';
import { fromInt16, getLocal, isLocal } from '../separate/db';
import { computeHighlights, isCatalog, loadCatalog, type Layered } from '../core/catalog';
import { drawDualLane, meanOffset, type DualState } from './dualLane';
import { useT, type I18nKey } from '../i18n';
import { drawLane, nearestNote, type LaneState, type TracePoint } from './lane';

interface Props {
  song: Song;
  nextTitle?: string;
  onExit(): void;
  onDone(result: ScoreResult, song: Song): void;
}

const PRAISE = ['好穩！', '太強了！', '停不下來！', '神準！', '這就是實力！', '全場安靜聽你唱！', '專業級！'];
const LINE_PRAISE = ['這句好聽！', '有味道！', '好穩！', '像原唱一樣！', '這句可以收錄了！'];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Stage({ song, nextTitle, onExit, onDone }: Props) {
  const t = useT();
  const cfg = useStore(settings);
  const saved = useStore(charts)[song.id];
  const isDemo = song.id === DEMO_ID;
  const cat = isCatalog(song.id);
  // layered songs: backing + original vocal as separate tracks (your own import, or the AI catalog)
  const own = isLocal(song.id) || cat;

  const [phase, setPhase] = useState<'ready' | 'live'>('ready');
  const [run, setRun] = useState(0); // bump to rebuild the player and start over
  const [title, setTitle] = useState(song.title);
  const [micErr, setMicErr] = useState<I18nKey | null>(null);
  const [ytErr, setYtErr] = useState<I18nKey | null>(null);
  const [chartErr, setChartErr] = useState(false);
  const [hud, setHud] = useState({ score: 0, note: '', level: 0, time: 0, dur: 0, playing: false });
  // your own song: tracks from this browser's storage
  const [local, setLocal] = useState<Layered | null>(null);
  const [localErr, setLocalErr] = useState(false);
  const [key, setKey] = useState(0);
  const [keyBusy, setKeyBusy] = useState(false);
  const [vocal, setVocal] = useState(0);
  const base = useRef<{ inst: Float32Array[]; voc: Float32Array[] } | null>(null);
  const video = useRef<YouTubeTransport | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const transport = useRef<Transport | null>(null);
  const mic = useRef(new MicPitch());
  const scorer = useRef<Scorer>(new FreeScorer());
  const trace = useRef<TracePoint[]>([]);
  const lane = useRef<LaneState>({ center: 60 });
  const dual = useRef<DualState>({ center: 60 });
  // encouragement: combo, high notes, per-line praise, gentle hints
  const newCoach = () => ({ idx: 0, combo: 0, max: 0, highHit: new Set<number>(), lines: new Map<number, number>(), lastHint: 0, lastPraise: 0, lastHigh: 0 });
  const coach = useRef(newCoach());
  const [pops, setPops] = useState<{ id: number; text: string; kind: string }[]>([]);
  const [combo, setCombo] = useState(0);
  const popId = useRef(0);
  const comboRef = useRef(0);
  const howlRef = useRef(false);
  const pop = (text: string, kind: string) => {
    const id = ++popId.current;
    setPops((p) => [...p.slice(-2), { id, text, kind }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1700);
  };

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
  // a catalog song without hosted audio plays its YouTube MV (with the original vocal), like KAREOKIE's web
  const hasAudio = !!local && local.inst.length > 0;
  const ytCat = own && !!local && !hasAudio && !!local.video;
  // with the URKTV extension (computer Chrome) the MV's vocal is removed on this computer, live
  const ext = useExtension();
  const [wantBacking, setWantBacking] = useState(true);
  const backing = ytCat && ext.present && ext.consent && wantBacking;
  const [countdown, setCountdown] = useState(0);

  // Values the animation loop reads without restarting.
  const live = useRef({ chart, offset: 0, transpose: 0, latency: 0, title, layered: local as Layered | null });
  live.current = {
    layered: local,
    chart,
    offset: own ? (ytCat ? local!.video!.offset : 0) : (saved?.offsetMs ?? 0) / 1000,
    transpose,
    latency: cfg.latencyMs / 1000,
    title,
  };

  useEffect(() => {
    const s = guide ? new GuideScorer(chart!, cfg.difficulty) : new FreeScorer();
    if (s instanceof GuideScorer) s.transpose = transpose;
    scorer.current = s;
    trace.current = [];
    coach.current = newCoach();
    setCombo(0);
  }, [chart, guide, cfg.difficulty, run]);
  useEffect(() => {
    if (scorer.current instanceof GuideScorer) scorer.current.transpose = transpose;
  }, [transpose]);

  // load the layered song's tracks
  useEffect(() => {
    if (!own) return;
    let off = false;
    const load: Promise<Layered | undefined> = cat
      ? loadCatalog(song.id.slice(4))
      : getLocal(song.id).then((s) =>
          s ? { title: s.title, notes: s.notes, lines: s.lines, inst: fromInt16(s.inst, 2), voc: fromInt16(s.voc, 1), rate: 44100 } : undefined,
        );
    load
      .then((s) => {
        if (off) return;
        if (!s) return setLocalErr(true);
        base.current = { inst: s.inst, voc: s.voc };
        if (!s.highlights) s.highlights = computeHighlights(s.notes);
        setTitle(s.title);
        setLocal(s);
      })
      .catch(() => !off && setLocalErr(true));
    return () => {
      off = true;
    };
  }, [own, cat, song.id]);

  // the player
  useEffect(() => {
    setYtErr(null);
    const host = hostRef.current!;
    if (own && !local) return;
    const plain = own && local!.inst.length === 0;
    const ytErrCb = (code: number) =>
      setYtErr(code === 101 || code === 150 ? 'stage.yt.embed' : code === -1 ? 'stage.yt.api' : 'stage.yt.gone');
    const tr: Transport = plain && backing
      ? new DualTransport(
          new YouTubeTransport(host, local!.video!.id, { muted: true, onError: ytErrCb }),
          new YouTubeTransport(leadRef.current!, local!.video!.id, { onError: ytErrCb }),
          LEAD,
        )
      : plain
      ? new YouTubeTransport(host, local!.video!.id, {
          onError: (code) =>
            setYtErr(code === 101 || code === 150 ? 'stage.yt.embed' : code === -1 ? 'stage.yt.api' : 'stage.yt.gone'),
        })
      : own
      ? new LocalTransport(base.current!.inst, base.current!.voc, vocal, local!.rate)
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
    // the MV as a muted picture that follows our audio clock
    let follow = 0;
    if (own && !plain && local?.video) {
      const v = local.video;
      const yt = new YouTubeTransport(host, v.id, { muted: true, onError: () => setYtErr(null) });
      video.current = yt;
      follow = window.setInterval(() => {
        const want = tr.time() + v.offset;
        if (tr.playing()) {
          if (!yt.playing()) yt.play();
          if (Math.abs(yt.time() - want) > 0.3) yt.seek(want);
        } else if (yt.playing()) {
          yt.pause();
          yt.seek(want);
        }
      }, 400);
    }
    return () => {
      window.clearInterval(follow);
      video.current?.destroy();
      video.current = null;
      tr.destroy();
      if (tr instanceof DualTransport) extPost({ type: 'stop' });
      if (!isDemo) host.replaceChildren();
      leadRef.current?.replaceChildren();
      transport.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, isDemo, own, local, run, backing]);

  // backing via the extension: tell it where the picture is, keep the lead player in front
  useEffect(() => {
    if (phase !== 'live' || !backing) return;
    const id = window.setInterval(() => {
      const tr = transport.current;
      if (!(tr instanceof DualTransport)) return;
      tr.keepAhead();
      extPost({ type: 'clock', t: tr.time(), playing: tr.playing() }); // MV time, same clock as the tapped audio
    }, 200);
    return () => window.clearInterval(id);
  }, [phase, backing, local]);

  const changeVocal = (v: number) => {
    setVocal(v);
    if (transport.current instanceof LocalTransport) transport.current.setVocal(v);
    if (transport.current instanceof DualTransport) extPost({ type: 'vocal', level: v });
  };

  /** Key change for your own song: re-pitch the backing and the guide vocal from the originals. */
  const changeKey = async (k: number) => {
    if (k === key) return;
    if (ytCat) {
      // the MV's own key cannot change: move the notes you are scored on instead
      setKey(k);
      return;
    }
    if (!base.current || keyBusy) return;
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
  const [howl, setHowl] = useState(false);
  // hearing yourself follows the settings while the mic runs
  useEffect(() => {
    if (phase === 'live') mic.current.setMonitor(cfg.monitor, cfg.monitorVol, cfg.echo);
  }, [phase, cfg.monitor, cfg.monitorVol, cfg.echo]);

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
    const res = scorer.current.result();
    const ch = live.current.chart;
    if (res.mode === 'guide' && ch) res.extras = extras(ch);
    onDone(res, { id: song.id, title: live.current.title });
  };
  /** What to celebrate on the result screen. */
  const extras = (ch: Chart): ScoreExtras => {
    const c = coach.current;
    const g = scorer.current as GuideScorer;
    const scored = ch.notes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind !== 'free');
    const hit = scored.filter(({ i }) => g.noteRatio(i) >= 0.5);
    const golden = scored.filter(({ n }) => n.kind === 'golden');
    let bestLine: ScoreExtras['bestLine'] = null;
    c.lines.forEach((ratio, li) => {
      const text = ch.lines[li]?.text;
      if (text && (!bestLine || ratio > bestLine.ratio)) bestLine = { text, ratio };
    });
    const similarity = scored.length ? hit.length / scored.length : 0;
    const longHit = hit.filter(({ n }) => n.end - n.start >= 1).length;
    const titles: string[] = [];
    if (golden.length && c.highHit.size >= Math.max(1, golden.length / 2)) titles.push('high');
    if (similarity >= 0.7) titles.push('stable');
    if (c.max >= 15) titles.push('combo');
    if (longHit >= 3) titles.push('long');
    if (!titles.length) titles.push('rising');
    return {
      maxCombo: c.max,
      highNotesHit: c.highHit.size,
      highNotesTotal: golden.length,
      highestHit: hit.length ? Math.max(...hit.map(({ n }) => n.midi + (g.transpose ?? 0))) : null,
      bestLine,
      similarity,
      titles,
    };
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

        // judge notes as they finish
        const g = scorer.current;
        if (g instanceof GuideScorer && notes) {
          const c = coach.current;
          while (c.idx < notes.length && notes[c.idx].end < tc) {
            const i = c.idx++;
            const n = notes[i];
            if (n.kind === 'free') continue;
            const ratio = g.noteRatio(i);
            if (ratio >= 0.5) {
              c.combo++;
              c.max = Math.max(c.max, c.combo);
              if (n.kind === 'golden' && !c.highHit.has(i)) {
                c.highHit.add(i);
                if (now - c.lastHigh > 2500) {
                  c.lastHigh = now;
                  pop('🔥 高音達成！', 'gold');
                }
              }
              if ([5, 10, 20, 30, 50, 80, 120].includes(c.combo)) pop(`連擊 ×${c.combo}！${PRAISE[c.combo % PRAISE.length]}`, 'combo');
            } else {
              c.combo = 0;
              const off = meanOffset(trace.current, n, L.transpose);
              // only clear misses, and rarely: hints should help, not nag
              if (off !== null && Math.abs(off) > 0.9 && now - c.lastHint > 10000) {
                c.lastHint = now;
                pop(off > 0 ? '再低一點點就完美了' : '再高一點點就完美了', 'hint');
              }
            }
            // a line just ended: praise it if it went well
            if (notes[c.idx]?.line !== n.line) {
              const ln = notes.map((x, k) => ({ x, k })).filter(({ x }) => x.line === n.line && x.kind !== 'free');
              const lr = ln.length ? ln.reduce((a, { k }) => a + g.noteRatio(k), 0) / ln.length : 0;
              c.lines.set(n.line, lr);
              if (lr >= 0.8 && now - c.lastPraise > 3000) {
                c.lastPraise = now;
                pop(LINE_PRAISE[(n.line + c.max) % LINE_PRAISE.length], 'praise');
              }
            }
          }
          if (c.combo !== comboRef.current) {
            comboRef.current = c.combo;
            setCombo(c.combo);
          }
        }
      }

      const ctx = cv.getContext('2d')!;
      const dpr = cv.width / Math.max(1, cv.clientWidth);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (notes) {
        drawDualLane(ctx, cv.clientWidth, cv.clientHeight, dual.current, {
          now: tc,
          trace: trace.current,
          notes,
          transpose: L.transpose,
          curve: L.layered?.curve,
          highlights: L.layered?.highlights,
        });
      } else {
        drawLane(ctx, cv.clientWidth, cv.clientHeight, lane.current, {
          now: tc,
          trace: trace.current,
          notes,
          transpose: L.transpose,
          live: frame.midi,
        });
      }

      if (now - lastHud > 120) {
        lastHud = now;
        if (mic.current.howl !== howlRef.current) {
          howlRef.current = mic.current.howl;
          setHowl(mic.current.howl);
        }
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
    const tr = transport.current;
    if (tr instanceof DualTransport) {
      // the lead player starts first; the AI gets LEAD seconds of head start
      const m = MODELS.kara2;
      extPost({ type: 'start', lead: LEAD, vocal, mode: 'auto', modelUrl: MODEL_BASE + m.file, ortBase: ORT_BASE, model: 'kara2' });
      tr.startStaggered(() => setCountdown(0));
      setCountdown(LEAD);
      const t0 = performance.now();
      const cd = window.setInterval(() => {
        const left = Math.ceil(LEAD - (performance.now() - t0) / 1000);
        setCountdown(Math.max(0, left));
        if (left <= 0) window.clearInterval(cd);
      }, 250);
    } else tr?.play();
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
          <div className={'video ' + (isDemo || (own && !local?.video) ? 'video-demo' : '')}>
            <div className="video-host" ref={hostRef} />
            {isDemo && <div className="demo-art">♪ Do · Re · Mi · Fa · Sol</div>}
            {own && !local?.video && <div className="demo-art">♪ {title}</div>}
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

          {countdown > 0 && <div className="notice ok countdown">🎛️ {t('ext.countdown', { n: countdown })}</div>}
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

          <div className={'lane-wrap' + (guide ? ' dual' : '')}>
            <canvas ref={canvasRef} className="lane" />
            <div className="pops" aria-live="polite">
              {pops.map((p) => (
                <div key={p.id} className={'pop pop-' + p.kind}>
                  {p.text}
                </div>
              ))}
            </div>
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
            {guide && (
              <div className={'combo' + (combo >= 5 ? ' hot' : '')}>
                {t('stage.combo')} ×{combo}
              </div>
            )}
            <div className="row between">
              <span className="label">{t('stage.note')}</span>
              <strong className="note-name">{hud.note || '–'}</strong>
            </div>
            <div className="label time">
              {fmt(hud.time)} / {fmt(hud.dur)}
            </div>
          </div>

          {ytCat && (
            <div className="card col">
              <div className="label">{t('ext.title')}</div>
              {!ext.present && (
                <p className="muted small">
                  {t('ext.install')}{' '}
                  <a href="extension.html" target="_blank" rel="noopener">
                    {t('ext.how')}
                  </a>
                </p>
              )}
              {ext.present && !ext.consent && (
                <>
                  <p className="small">{t('ext.consent')}</p>
                  <div className="row wrap">
                    <button className="btn primary small" onClick={() => extPost({ type: 'consent', ok: true })}>
                      {t('ext.agree')}
                    </button>
                    <button className="btn small" onClick={() => setWantBacking(false)}>
                      {t('ext.original')}
                    </button>
                  </div>
                </>
              )}
              {ext.present && ext.consent && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={wantBacking} disabled={phase === 'live'} onChange={(e) => setWantBacking(e.target.checked)} />
                    {t('ext.on')}
                  </label>
                  {backing && (
                    <>
                      {/* the lead player must stay visible and uncovered (YouTube rules): it sits here, not over the MV */}
                      <div className="lead-box" title={t('ext.leadTitle')}>
                        <span className="lead-label">{t('ext.lead')}</span>
                        <div className="lead-host" ref={leadRef} />
                      </div>
                      <label className="field">
                        <span>
                          {t('mine.vocal')} · {Math.round(vocal * 100)}%
                        </span>
                        <input type="range" min={0} max={1} step={0.05} value={vocal} onChange={(e) => changeVocal(Number(e.target.value))} />
                      </label>
                      {ext.status && (
                        <small className="muted">
                          {ext.status.state === 'error'
                            ? t(ext.status.message === 'audio-blocked' ? 'ext.blocked' : 'ext.error')
                            : ext.status.state === 'loading'
                            ? t('ext.loading')
                            : ext.status.mode === 'ai'
                              ? t('ext.ai', { x: (ext.status.speed ?? 0).toFixed(1) })
                              : t('ext.classic')}
                          {ext.status.buffered !== undefined && phase === 'live' ? ' · ' + t('ext.ahead', { s: Math.max(0, ext.status.buffered).toFixed(1) }) : ''}
                        </small>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

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

          <div className="card col">
            <label className="check">
              <input type="checkbox" checked={cfg.monitor} onChange={(e) => setCfg({ monitor: e.target.checked })} />
              🎧 {t('stage.monitor')}
            </label>
            {cfg.monitor && (
              <>
                <label className="field">
                  <span>
                    {t('stage.monitorVol')} · {Math.round(cfg.monitorVol * 100)}%
                  </span>
                  <input type="range" min={0} max={1.5} step={0.05} value={cfg.monitorVol} onChange={(e) => setCfg({ monitorVol: Number(e.target.value) })} />
                </label>
                <label className="field">
                  <span>
                    {t('stage.echo')} · {Math.round(cfg.echo * 100)}%
                  </span>
                  <input type="range" min={0} max={1} step={0.05} value={cfg.echo} onChange={(e) => setCfg({ echo: Number(e.target.value) })} />
                </label>
                <small className="muted">{t('stage.monitorHint')}</small>
              </>
            )}
            {howl && (
              <div className="notice warn">
                {t('stage.howl')}{' '}
                <button className="btn small" onClick={() => mic.current.setMonitor(cfg.monitor, cfg.monitorVol, cfg.echo)}>
                  {t('stage.howlOn')}
                </button>
              </div>
            )}
          </div>

          {own && local && (
            <div className="card col">
              {hasAudio ? (
                <label className="field">
                  <span>
                    {t('mine.vocal')} · {Math.round(vocal * 100)}%
                  </span>
                  <input type="range" min={0} max={1} step={0.05} value={vocal} onChange={(e) => changeVocal(Number(e.target.value))} />
                </label>
              ) : (
                <p className="muted small">{backing ? t('ext.backingNote') : t('stage.assisted')}</p>
              )}
              <div className="field">
                <span>
                  {t('stage.key')} · {key > 0 ? '+' : ''}
                  {key} {t('common.semitone')}
                  {keyBusy ? ' · ' + t('mine.keyBusy') : ''}
                </span>
                {ytCat && <small className="muted">{t('stage.keyNotes')}</small>}
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
