import { useEffect, useMemo, useRef, useState } from 'react';
import { MicPitch } from '../audio/mic';
import { midiName } from '../audio/pitch';
import { lineAt, parseChart, type Chart, type Note } from '../core/chart';
import { foldNear, FreeScorer, GuideScorer, type Difficulty, type ScoreExtras, type Scorer, type ScoreResult } from '../core/score';
import { charts, DEMO_ID, renameSong, settings, useStore, type Song } from '../core/store';
import { demoChart, DualTransport, LocalTransport, SynthTransport, toUltraStar, YouTubeTransport, type Transport } from '../core/transport';
import { extPost, LEAD, LITE_AHEAD, useExtension } from '../core/extension';
import { MODELS } from '../separate/mdx';
import { MODEL_BASE, ORT_BASE } from '../separate/client';
import { runWorker } from '../separate/client';
import { fromInt16, getLocal, isLocal } from '../separate/db';
import { computeHighlights, isCatalog, loadCatalog, type Layered } from '../core/catalog';
import { LiveNotes } from '../core/liveNotes';
import { ExtUpdate } from './ExtUpdate';
import { Prep } from './Prep';
import { cheer } from './cheers';
import { findLyrics } from '../core/lyricsSearch';
import { loadPitch, savePitch } from '../core/songCache';
import { drawDualLane, meanOffset, type DualState } from './dualLane';
import { useT, type I18nKey } from '../i18n';
import { drawLane, nearestNote, type LaneState, type TracePoint } from './lane';

interface Props {
  song: Song;
  nextTitle?: string;
  onExit(): void;
  onDone(result: ScoreResult, song: Song): void;
}

/** Version of the lyrics search; lyrics saved by an older one are looked up again. */
const LYRICS_V = 3;
// ?debug: the lyrics search can be tried from the console
if (typeof location !== 'undefined' && /[?&]debug\b/.test(location.search)) (window as any).urktvFindLyrics = findLyrics;


/** About how long a lyric line takes to sing (web lyrics only give when it starts). */
const sungDur = (text: string) => Math.max(1, text.replace(/\s/g, '').length * 0.33 + 0.4);

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
  const [hud, setHud] = useState({ score: 0, note: '', level: 0, time: 0, dur: 0, playing: false });
  // your own song: tracks from this browser's storage
  const [local, setLocal] = useState<Layered | null>(null);
  const [localErr, setLocalErr] = useState(false);
  const [key, setKey] = useState(0);
  const [keyBusy, setKeyBusy] = useState(false);
  const [vocal, setVocal] = useState(1); // the original by default
  const vocalRef = useRef(0);
  vocalRef.current = vocal;
  const base = useRef<{ inst: Float32Array[]; voc: Float32Array[] } | null>(null);
  const video = useRef<YouTubeTransport | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ktvRef = useRef<HTMLDivElement>(null);
  const transport = useRef<Transport | null>(null);
  const mic = useRef(new MicPitch());
  const scorer = useRef<Scorer>(new FreeScorer());
  const trace = useRef<TracePoint[]>([]);
  const lane = useRef<LaneState>({ center: 60 });
  const dual = useRef<DualState>({ center: 60 });
  // encouragement: combo, high notes, per-line praise, gentle hints
  const newCoach = () => ({ idx: 0, combo: 0, max: 0, highHit: new Set<number>(), lines: new Map<number, number>(), lastHint: 0, lastPraise: 0, lastHigh: 0 });
  const coach = useRef(newCoach());
  // live gray bars (made by the extension): which notes were judged, how high the song goes
  const liveJudge = useRef({ done: new Set<number>(), run: 0, mids: new Map<number, number>() });
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
  // a catalog song without hosted audio plays its YouTube MV (with the original vocal), like KAREOKIE's web
  const hasAudio = !!local && local.inst.length > 0;
  const ytCat = own && !!local && !hasAudio && !!local.video;
  // with the URKTV extension (computer Chrome) the MV's vocal is removed on this computer, live
  const ext = useExtension();
  // with the extension, every mode runs through it: the original too (its gray bars and lyric timing
  // come from the separated vocal); without it, the plain MV
  const [wantBacking] = useState(true);
  // AI backing (clean, may need a head start) or fast backing (classic cut: starts at once, duller)
  // high-quality AI for the backing (a second step: it can mean a long wait); else the light AI
  const [hq, setHq] = useState(false);
  // the guide vocal: the original kept faintly under the backing, at the singer's own level
  const [guideLvl, setGuideLvl] = useState(() => Number(localStorage.getItem('urktv.guide')) || 0.25);
  const [hqAsk, setHqAsk] = useState(false); // high quality is a second step: it can mean a long wait
  const hqRef = useRef(hq);
  hqRef.current = hq;
  // any YouTube song can get the live backing track: library songs, and links pasted on Home
  const ytPlain = !own && !isDemo;
  const ytAny = ytCat || ytPlain;
  const backing = ytAny && ext.present && wantBacking;
  // with the extension the backing changes key too; own songs re-pitch their tracks
  const transpose = own || (ytAny && ext.present) ? key : saved?.transpose ?? 0;
  // installing the extension is the consent; the extension still keeps the flag
  useEffect(() => {
    if (ext.present && !ext.consent) extPost({ type: 'consent', ok: true });
  }, [ext.present, ext.consent]);
  // get the light AI ready while the singer looks at the page (it is then instant on start)
  useEffect(() => {
    if (backing) extPost({ type: 'preload', liteBase: MODEL_BASE });
  }, [backing]);
  const [backingFailed, setBackingFailed] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const triedLyrics = useRef('');
  // lyrics found by an older search (it could pick another song from the same drama): look again
  const staleAuto = saved?.kind === 'lrc' && saved.auto !== LYRICS_V && saved.offsetMs === 0 && !saved.name?.startsWith('manual');
  useEffect(() => {
    if (!ytPlain || (saved && !staleAuto) || !title || title.startsWith('YouTube · ') || triedLyrics.current === title) return;
    triedLyrics.current = title;
    let off = false;
    const go = () =>
      findLyrics(title, transport.current?.duration() || 0).then((hit) => {
        if (off) return;
        if (!hit) {
          if (staleAuto) removeChart();
          return;
        }
        charts.set((c) => ({ ...c, [song.id]: { raw: hit.lrc, kind: 'lrc', offsetMs: 0, transpose: 0, auto: LYRICS_V, name: hit.name } }));
      });
    // the video's length helps pick the right version: give the player a moment to know it
    const id = window.setTimeout(go, transport.current?.duration() ? 0 : 1500);
    return () => {
      off = true;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytPlain, saved, title, song.id]);
  const [diagCopied, setDiagCopied] = useState(false);
  // getting the backing ready: progress 0-100, or null while the model loads
  const [prep, setPrep] = useState<{ pct: number | null; label: string } | null>(null);
  const mainSince = useRef(0);
  const manualLyrics = useRef(false);
  const alignHist = useRef<number[]>([]);
  const lastRestart = useRef(0);
  const [hold, setHold] = useState<number | null>(null); // mid-song wait: progress 0-100
  // gray bars made live by the extension (songs without prepared bars)
  const liveNotes = useRef(new LiveNotes());
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== window || e.data?.source !== 'urktv-ext' || e.data.type !== 'pitch') return;
      liveNotes.current.add(e.data.t, e.data.hop, e.data.midi);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  // sung here before: the vocal's pitch is already known (gray bars for the whole song at once,
  // lyrics timed from the start); keep what is learned now for next time
  useEffect(() => {
    if (!ytPlain) return;
    void loadPitch(song.id).then((c) => c && liveNotes.current.restore(c));
    if (/[?&]debug\b/.test(location.search)) (window as any).urktvLive = liveNotes.current;
    const save = () => {
      const d = liveNotes.current.dump();
      if (d && d.data.length > 200) void savePitch(song.id, d);
    };
    const id = window.setInterval(save, 15000);
    return () => {
      window.clearInterval(id);
      save();
    };
  }, [ytPlain, song.id]);
  const rebuffering = useRef(false);
  const extRef = useRef(ext);
  extRef.current = ext;

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
    liveJudge.current = { done: new Set(), run: 0, mids: new Map() };
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
      : ytPlain && backing
      ? new DualTransport(
          new YouTubeTransport(host, song.id, { muted: true, onError: ytErrCb, onTitle: (name) => setTitle(name) }),
          new YouTubeTransport(leadRef.current!, song.id, { onError: ytErrCb }),
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
      const st = extRef.current.status;
      // the extension's engine was reopened by Chrome and knows nothing: start it again from here
      if (st?.state === 'lost' && tr.started && !tr.solo && performance.now() - lastRestart.current > 3000) {
        lastRestart.current = performance.now();
        extPost(startMsg());
        rebuffering.current = true;
        tr.main.pause();
        tr.seek(tr.time(), true);
      }
      if (st?.mode === 'ai' && (st.speed ?? 0) > 0) localStorage.setItem('urktv.aiSpeed', String(st.speed));
      const left = Math.max(0, (tr.duration() || 300) - tr.time());
      // the lead runs as far ahead as the chosen model needs
      const pl = plan(left);
      const want = pl.resume + 0.5;
      if (tr.started) tr.ahead = Math.max(2, pl.ahead);
      if (!rebuffering.current) tr.keepAhead();
      if (!tr.solo && mainSince.current) {
        // no word from the extension for 2 s: it is stuck, there is no backing to play
        const fresh = performance.now() - ((st as any)?.at ?? 0) < 2000;
        const b = fresh ? st?.buffered ?? 0 : 0;
        if (tr.playing() && b < 0.8) {
          // like a video buffering: the picture waits for the backing, the small window keeps going
          tr.holdForBacking();
          rebuffering.current = true;
        } else if (rebuffering.current && (b >= Math.min(want, 600) - 0.5 || (tr.lead.ended() && b > 0.3))) {
          rebuffering.current = false;
          tr.main.play();
        }
        const pct = rebuffering.current && !tr.lead.ended() ? Math.round((Math.max(0, b) / Math.max(0.5, Math.min(want, 600) - 0.5)) * 100) : null;
        setHold((h) => (h === pct ? h : pct));
      }
      // the backing follows the picture: while the picture plays, so does the backing (even if the
      // lead is waiting for it to catch up: what the picture needs is already in the buffer)
      extPost({ type: 'clock', t: tr.time(), playing: tr.playing() });
      // safety net: the picture has been playing for 6 s and the extension still hears nothing
      if (tr.playing() && !tr.solo) {
        if (!mainSince.current) mainSince.current = performance.now();
        const blocks = Number((extRef.current.status?.diag as any)?.blocks ?? 0);
        if (blocks === 0 && performance.now() - mainSince.current > 6000) {
          tr.fallbackToOriginal();
          extPost({ type: 'stop' });
          setBackingFailed(true);
        }
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [phase, backing, local]);

  // lyrics from the web follow the album, the MV often has an intro: line them up with where the
  // separated vocal actually sings (until you fix them by hand)
  useEffect(() => {
    if (phase !== 'live' || saved?.kind !== 'lrc' || !chart?.lines.length) return;
    const id = window.setInterval(() => {
      if (manualLyrics.current) return;
      const lines = chart.lines.filter((l) => l.text.trim()).map((l) => ({ start: l.start, end: Math.min(l.end, l.start + sungDur(l.text)) }));
      const r = liveNotes.current.alignOffset(lines, 60);
      if (!r || r.voiced < 12) return;
      // settled: three answers in a row agree with plenty heard -> stop moving the lyrics
      const hist = alignHist.current;
      hist.push(r.off);
      if (hist.length > 3) hist.shift();
      if (hist.length === 3 && r.voiced > 30 && Math.max(...hist) - Math.min(...hist) < 0.35) manualLyrics.current = true;
      const cur = (saved.offsetMs ?? 0) / 1000;
      if (Math.abs(r.off - cur) >= 0.3) patchChart({ offsetMs: Math.round(r.off * 1000) });
    }, 4000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, saved?.kind, saved?.offsetMs, chart]);

  /** Everything needed to see where the backing track gets stuck, as text to copy. */
  const diagText = () => {
    const tr = transport.current;
    const d = (ext.status?.diag ?? {}) as Record<string, unknown>;
    const fmt2 = (x: unknown) => (typeof x === 'number' ? x.toFixed(2) : String(x ?? '-'));
    return [
      `擴充功能：${ext.present ? 'v' + ext.version : '沒偵測到'}，同意：${ext.consent ? '是' : '否'}，伴奏版：${backing ? '開' : '關'}`,
      `原版小視窗：${tr instanceof DualTransport ? `${tr.lead.playing() ? '播放中' : '沒在播'} ${fmt2(tr.lead.time())} 秒` : '-'}`,
      `主畫面：${tr instanceof DualTransport ? `${tr.main.playing() ? '播放中' : '沒在播'} ${fmt2(tr.main.time())} 秒${tr.syncing() ? '（等待同步）' : ''}` : '-'}`,
      `擷取：${ext.tap === 'connected' ? '已接上' : ext.tap === 'blocked' ? '被瀏覽器擋住' : '還沒接上'}`,
      `引擎：${ext.status?.state ?? '-'} / ${ext.status?.mode ?? '-'}，速度 ${fmt2(ext.status?.speed)} 倍，領先 ${fmt2(ext.status?.buffered)} 秒`,
      `收到聲音 ${d.blocks ?? '-'} 段（最後 ${fmt2(d.lastTap)} 秒），待播 ${d.segments ?? '-'} 段，已播 ${d.played ?? '-'} 段，重來 ${d.resets ?? '-'} 次`,
      `引擎時鐘 ${fmt2(d.clock)} 秒（${d.playing ? '播放中' : '暫停'}），音訊 ${d.ctx ?? '-'}${d.err ? '，錯誤：' + d.err : ''}${ext.status?.message ? '，訊息：' + ext.status.message : ''}`,
      `瀏覽器：${navigator.userAgent}`,
    ].join('\n');
  };

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

  /** Key change on a YouTube song: the extension re-pitches the backing; bars and scoring follow. */
  const changeLiveKey = (k: number) => {
    k = Math.max(-6, Math.min(6, k));
    setKey(k);
    extPost({ type: 'key', semitones: k });
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
      let notes = L.chart?.hasPitch ? L.chart.notes : null;
      // no prepared bars: the ones the extension makes from the separated vocal (media time -> chart time)
      if (!notes && liveNotes.current.has()) {
        notes = liveNotes.current.between(time - 4, time + 8).map((n) => ({ ...n, start: n.start - L.offset, end: n.end - L.offset }));
      }
      const liveBars = !(L.chart?.hasPitch) && !!notes;

      if (playing) {
        const tp = trace.current;
        if (tp.length && tc < tp[tp.length - 1].t - 0.5) tp.length = 0; // jumped back
        const r = scorer.current.push(tc, frame.midi, dt);
        let shown = frame.midi;
        if (shown !== null && notes) {
          const target = nearestNote(notes, tc);
          if (target) shown = foldNear(shown, target.midi + L.transpose);
        }
        let hit = r.hit;
        if (liveBars && shown !== null && notes) {
          const target = nearestNote(notes, tc);
          hit = !!target && tc >= target.start - 0.15 && tc <= target.end + 0.15 && Math.abs(shown - (target.midi + L.transpose)) < 1;
        }
        tp.push({ t: tc, midi: shown, hit });
        while (tp.length && tp[0].t < tc - 10) tp.shift();

        // judge notes as they finish
        const g = scorer.current;
        if (g instanceof GuideScorer && notes && !liveBars) {
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
                  pop(cheer('high'), 'gold');
                }
              }
              if ([5, 10, 20, 30, 50, 80, 120].includes(c.combo)) pop(cheer('combo', c.combo), 'combo');
            } else {
              c.combo = 0;
              const off = meanOffset(trace.current, n, L.transpose);
              // only clear misses, and rarely: hints should help, not nag
              if (off !== null && Math.abs(off) > 0.9 && now - c.lastHint > 10000) {
                c.lastHint = now;
                pop(cheer(off > 0 ? 'lower' : 'higher'), 'hint');
              }
            }
            // a line just ended: praise it if it went well
            if (notes[c.idx]?.line !== n.line) {
              const ln = notes.map((x, k) => ({ x, k })).filter(({ x }) => x.line === n.line && x.kind !== 'free');
              const lr = ln.length ? ln.reduce((a, { k }) => a + g.noteRatio(k), 0) / ln.length : 0;
              c.lines.set(n.line, lr);
              if (lr >= 0.8 && now - c.lastPraise > 3000) {
                c.lastPraise = now;
                pop(cheer('line'), 'praise');
              }
            }
          }
          if (c.combo !== comboRef.current) {
            comboRef.current = c.combo;
            setCombo(c.combo);
          }
        }
      }

      // live bars: judge each note as it ends (combo, praise, hints), like prepared songs
      if (playing && liveBars && notes) {
        const J = liveJudge.current;
        const c = coach.current;
        for (const n of notes) {
          if (n.end >= tc - 0.05 || n.end < tc - 1.5) continue;
          const key = Math.round(n.start * 20);
          if (J.done.has(key)) continue;
          J.done.add(key);
          let tot = 0;
          let hit = 0;
          for (const p of trace.current) {
            if (p.t < n.start || p.t > n.end || p.midi === null) continue;
            tot++;
            if (p.hit) hit++;
          }
          if (n.end - n.start < 0.25) continue; // too short to judge fairly
          const ratio = tot ? hit / tot : 0;
          if (ratio >= 0.5) {
            c.combo++;
            c.max = Math.max(c.max, c.combo);
            J.run++;
            const high = (J.mids.get(-1) ?? 0) && n.midi >= (J.mids.get(-1) ?? 999);
            if (high && now - c.lastHigh > 2500) {
              c.lastHigh = now;
              pop(cheer('high'), 'gold');
            } else if ([5, 10, 20, 30, 50, 80, 120].includes(c.combo)) pop(cheer('combo', c.combo), 'combo');
            else if (J.run >= 4 && now - c.lastPraise > 4000) {
              c.lastPraise = now;
              J.run = 0;
              pop(cheer('line'), 'praise');
            }
          } else {
            c.combo = 0;
            J.run = 0;
            const off = tot >= 5 ? meanOffset(trace.current, n, L.transpose) : null;
            if (off !== null && Math.abs(off) > 0.9 && now - c.lastHint > 10000) {
              c.lastHint = now;
              pop(cheer(off > 0 ? 'lower' : 'higher'), 'hint');
            }
          }
        }
        if (c.combo !== comboRef.current) {
          comboRef.current = c.combo;
          setCombo(c.combo);
        }
      }

      ktvRef.current?.style.setProperty('--t', String(time - L.offset));
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
          highlights: L.layered?.highlights ?? (liveBars && notes ? liveHighs(notes) : undefined),
          syl: sylNear(tc),
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

  /** This computer's AI speed (× real time): measured now, or remembered from last time. */
  const aiSpeed = () => {
    const st = extRef.current.status;
    if (st?.mode === 'ai' && (st.speed ?? 0) > 0) return st.speed!;
    return Number(localStorage.getItem('urktv.aiSpeed')) || 0;
  };
  /** What the extension should run: the high-quality AI, or the light AI (original and fast backing). */
  const engineMode = () => (hqRef.current && !extRef.current.fellBack ? 'ai' : 'lite');
  const startMsg = () => {
    const md = MODELS.kara2;
    return { type: 'start', lead: LEAD, vocal: vocalRef.current, mode: engineMode(), modelUrl: MODEL_BASE + md.file, ortBase: ORT_BASE, model: 'kara2', liteBase: MODEL_BASE };
  };
  /** How far ahead the lead player should run, and how much backing to have before (re)starting. */
  const plan = (left: number) => {
    const st = extRef.current.status;
    if (engineMode() === 'ai' && st?.mode !== 'lite') {
      const n = aiNeed(aiSpeed() || 1, left);
      return { ahead: n, resume: Math.min(n, 600) - 0.5 };
    }
    if (st?.mode === 'classic') return { ahead: 2, resume: 1.5 }; // light AI could not load
    return { ahead: LITE_AHEAD, resume: 2 };
  };
  /** Seconds of AI backing to have ready so it lasts `left` seconds of song at speed sp. */
  const aiNeed = (sp: number, left: number) => (sp >= 1.15 ? 8 : Math.min(600, left * (1 / sp - 1) + 8));

  /** Original 100 % / guide (the original faintly) / backing 0 %: only the vocal level changes. */
  const vocalPreset = (v: number) => {
    if (!backing) return;
    changeVocal(v);
  };
  /** High quality on or off: the extension switches models; the picture waits for the new one. */
  const setQuality = (on: boolean) => {
    if (!backing) return;
    const before = engineMode();
    if (on) extRef.current.fellBack = false;
    hqRef.current = on;
    setHq(on);
    const after = engineMode();
    if (phase !== 'live' || before === after) return;
    extPost({ ...startMsg(), type: 'setmode' });
    const tr = transport.current;
    if (tr instanceof DualTransport && tr.started) {
      rebuffering.current = true;
      tr.main.pause();
      tr.seek(tr.time(), true);
    }
  };

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
      // the lead player starts first and the chosen model gets its head start
      extRef.current.fellBack = false;
      extPost(startMsg());
      let started = false;
      const t0 = performance.now();
      tr.startStaggered(
        () => {
          started = true;
          setPrep(null);
        },
        () => {
          const st = extRef.current.status;
          const waited = performance.now() - t0;
          if (engineMode() === 'ai' && !(aiSpeed() > 0) && waited > 40000) {
            // the AI never answered on this computer: the light AI, so the song can start
            extRef.current.fellBack = true;
            extPost({ ...startMsg(), type: 'setmode' });
          }
          // the light AI still loading: wait for it (a few seconds), not for the old cut
          if (engineMode() === 'lite' && st?.mode !== 'lite' && waited < 15000 && !extRef.current.fellBack) return false;
          if (engineMode() === 'ai' && st?.mode !== 'ai' && !(aiSpeed() > 0)) return false;
          const pl = plan(tr.duration() || 300);
          tr.ahead = pl.ahead;
          // the light AI starts as soon as a little backing is ready; the AI needs its full head start
          return (st?.buffered ?? 0) >= pl.resume && (engineMode() === 'lite' || tr.lead.time() >= Math.min(pl.ahead, 600) - 1);
        },
      );
      setPrep({ pct: null, label: '載入 AI 模型' });
      const cd = window.setInterval(() => {
        if (started || tr.started) {
          setPrep(null);
          return window.clearInterval(cd);
        }
        const st = extRef.current.status;
        if (!st || st.state === 'loading' || (engineMode() === 'lite' && st.mode !== 'lite' && !extRef.current.fellBack)) {
          setPrep({ pct: null, label: '載入 AI 模型（第一次要下載，之後很快）' });
          return;
        }
        const pl = plan(tr.duration() || 300);
        const b = Math.max(0, st.buffered ?? 0);
        setPrep({ pct: (b / Math.max(0.5, pl.resume)) * 100, label: engineMode() === 'ai' ? '高品質 AI 正在分析這首歌' : 'AI 正在分析這首歌' });
      }, 250);
    } else tr?.play();
    setPhase('live');
  };

  /** Jump in the song (also over the intro). Scoring then counts only the notes you reached. */
  const seekTo = (t: number) => {
    const tr = transport.current;
    if (!tr) return;
    const d = tr.duration() || 0;
    const to = Math.max(0, d ? Math.min(t, d - 1) : t);
    tr.seek(to + (live.current.offset || 0) * 0);
    trace.current = [];
    if (scorer.current instanceof GuideScorer) scorer.current.skipped = true;
    const notes = live.current.chart?.notes ?? [];
    const tc = to - live.current.offset;
    coach.current.idx = Math.max(0, notes.findIndex((n) => n.end >= tc));
    coach.current.combo = 0;
  };
  const firstVoice = () => {
    const c = live.current.chart;
    const first = c?.lines[0]?.start ?? c?.notes[0]?.start;
    return first !== undefined ? Math.max(0, first + live.current.offset - 3) : null;
  };

  const restart = () => {
    setPhase('ready');
    setHud((h) => ({ ...h, score: 0, time: 0, playing: false }));
    setRun((r) => r + 1);
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
  /** KTV rows: even lines on the top row (left), odd lines on the bottom row (right); each row shows
   *  its line until it has been sung, then the next one of its parity. */
  const ktvLine = (row: number) => {
    if (!chart) return -1;
    for (let j = row; j < chart.lines.length; j += 2) if (chart.lines[j].end > tl - 0.4) return j;
    return -1;
  };

  /** Lyric characters around now, with their sung times, to write on the bars. */
  const sylNear = (tc: number) => {
    const ch = live.current.chart;
    if (!ch?.lines.length) return undefined;
    const out: { start: number; end: number; text: string }[] = [];
    ch.lines.forEach((l, j) => {
      if (l.end < tc - 3 || l.start > tc + 7) return;
      for (const p of l.parts.length ? l.parts : lrcParts(j)) out.push(p);
    });
    return out;
  };
  /** High notes among the live bars: near the top of what the song has reached so far, and held. */
  const liveHighs = (notes: Note[]) => {
    const J = liveJudge.current;
    for (const n of notes) J.mids.set(Math.round(n.start * 20), n.midi);
    const all = [...J.mids.entries()].filter(([k]) => k >= 0).map(([, m]) => m).sort((a, b) => a - b);
    if (all.length < 12) return undefined; // not enough of the song heard yet to know what is high
    const top = all[Math.floor(all.length * 0.9)];
    const med = all[all.length >> 1];
    const bar = Math.max(top, med + 4);
    J.mids.set(-1, bar);
    return notes.filter((n) => n.midi >= bar && n.end - n.start >= 0.35).map((n) => ({ start: n.start, end: n.end, peak: midiName(n.midi + transpose) }));
  };
  /** A web-lyrics line's characters, timed to where the separated vocal sings (else an estimate). */
  const lrcParts = (j: number) => {
    const line = chart!.lines[j];
    const off = live.current.offset;
    const next = chart!.lines[j + 1]?.start ?? line.start + 12;
    const est = [{ start: line.start, end: Math.min(line.end, line.start + sungDur(line.text)), text: line.text }];
    if (!liveNotes.current.has()) return est;
    const parts = liveNotes.current.charTimes(line.text, line.start + off - 0.5, Math.min(next, line.start + sungDur(line.text) * 1.8) + off - 0.15);
    return parts ? parts.map((p) => ({ ...p, start: p.start - off, end: p.end - off })) : est;
  };

  return (
    <div className="stage neon">
      <div className="beams" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="stage-top">
        <button className="btn ghost" onClick={onExit}>
          ← {t('stage.back')}
        </button>
        <h1 className="stage-title">{isDemo ? t('stage.demoTitle') : title}</h1>
        <span className={'chip ' + (guide ? 'chip-on' : '')}>{t(guide ? 'stage.mode.guide' : 'stage.mode.free')}</span>
      </header>
      <ExtUpdate />

      <div className="stage-grid">
        <section className="stage-main">
          <div className={'video ' + (isDemo || (own && !local?.video) ? 'video-demo' : '')}>
            <div className="video-host" ref={hostRef} />
            {isDemo && <div className="demo-art">♪ Do · Re · Mi · Fa · Sol</div>}
            {own && !local?.video && <div className="demo-art">♪ {title}</div>}
            {ytErr && <div className="overlay error">{t(ytErr)}</div>}
            {phase === 'live' && backing && prep && (
              <Prep
                pct={prep.pct}
                label={prep.label}
                sub={hq && aiSpeed() > 0 && aiSpeed() < 1.15 ? `你的電腦算高品質 AI 是 ${aiSpeed().toFixed(1)} 倍速，所以要先多算一段` : undefined}
                onFast={hq ? () => setQuality(false) : undefined}
              />
            )}
            {phase === 'live' && backing && !prep && hold !== null && (
              <Prep
                pct={hold}
                label={hq && !extRef.current.fellBack ? '高品質伴奏跟上中' : '伴奏跟上中'}
                sub={hq && aiSpeed() > 0 && aiSpeed() < 1.15 ? `你的電腦算高品質 AI 是 ${aiSpeed().toFixed(1)} 倍速，比歌慢` : undefined}
                onFast={hq ? () => setQuality(false) : undefined}
              />
            )}
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
          <div className={'ktv' + (chart && chart.lines.length ? '' : ' empty')} ref={ktvRef} aria-live="off">
            {chart && chart.lines.length > 0 ? (
              [0, 1].map((row) => {
                const j = ktvLine(row);
                const line = j >= 0 ? chart.lines[j] : null;
                const prevEnd = j > 0 ? chart.lines[j - 1].end : -99;
                const dots = line && line.start - tl > 0 && line.start - tl <= 3 && line.start - prevEnd > 2 ? Math.ceil(line.start - tl) : 0;
                return (
                  <p key={row} className={'ktv-row ' + (row ? 'r' : 'l') + (j === li ? ' now' : '')}>
                    {dots > 0 && <span className="ktv-dots">{'●'.repeat(dots)}</span>}
                    {line &&
                      (line.parts.length ? line.parts : lrcParts(j)).map((p, k) => (
                        <span
                          key={k}
                          className="ktv-ch"
                          style={{ ['--s' as string]: p.start, ['--d' as string]: Math.max(0.05, p.end - p.start) } as React.CSSProperties}
                        >
                          {p.text}
                        </span>
                      ))}
                  </p>
                );
              })
            ) : (
              <p className="lyric-next">{chart ? '♪' : ''}</p>
            )}
          </div>

          {phase === 'live' && (
            <div className="stage-bar">
              <button className="btn icon play" onClick={() => (hud.playing ? transport.current?.pause() : transport.current?.play())} aria-label={hud.playing ? t('stage.pause') : t('stage.resume')}>
                {hud.playing ? '❚❚' : '▶'}
              </button>
              {!isDemo && (
                <>
                  <button className="btn icon" onClick={() => seekTo(hud.time - 10)} aria-label="-10">⏪</button>
                  <span className="seek-time">{fmt(drag ?? hud.time)}</span>
                  <input
                    className="seek"
                    type="range"
                    min={0}
                    max={Math.max(1, Math.floor(hud.dur))}
                    step={1}
                    value={drag ?? Math.floor(hud.time)}
                    aria-label={t('stage.seek')}
                    style={{ ['--p' as string]: `${hud.dur ? ((drag ?? hud.time) / hud.dur) * 100 : 0}%` } as React.CSSProperties}
                    onChange={(e) => setDrag(Number(e.target.value))}
                    onPointerUp={() => drag !== null && (seekTo(drag), setDrag(null))}
                    onKeyUp={() => drag !== null && (seekTo(drag), setDrag(null))}
                    onBlur={() => setDrag(null)}
                  />
                  <span className="seek-time">{fmt(hud.dur)}</span>
                  <button className="btn icon" onClick={() => seekTo(hud.time + 10)} aria-label="+10">⏩</button>
                  {firstVoice() !== null && hud.time < (firstVoice() ?? 0) && (
                    <button className="btn small" onClick={() => seekTo(firstVoice()!)}>
                      {t('stage.skipIntro')}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {ytAny && !backingFailed && (
            <div className="sing-mode">
              <div className="seg big" role="radiogroup" aria-label="原唱、導唱或伴唱">
                {(
                  [
                    ['🎤 原唱', 1],
                    ['🎙️ 導唱', guideLvl],
                    ['🎶 伴唱', 0],
                  ] as const
                ).map(([label, v]) => {
                  const on = backing ? Math.abs(vocal - v) < 0.01 : v === 1;
                  return (
                    <button key={label} role="radio" aria-checked={on} disabled={v !== 1 && !ext.present} className={'seg-btn' + (on ? ' on' : '')} onClick={() => vocalPreset(v)}>
                      {label}
                    </button>
                  );
                })}
              </div>
              {backing && (
                <label className="vocal-slider" title="原唱人聲大小：拉到你喜歡的導唱程度">
                  <span>人聲 {Math.round(vocal * 100)}%</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={vocal}
                    style={{ ['--p' as string]: `${vocal * 100}%` } as React.CSSProperties}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      changeVocal(v);
                      // a level between the ends becomes this singer's guide level
                      if (v > 0.02 && v < 0.98) {
                        setGuideLvl(v);
                        localStorage.setItem('urktv.guide', String(v));
                      }
                    }}
                  />
                </label>
              )}
              {backing && (
                <div className="seg small-seg" role="radiogroup" aria-label="去人聲品質">
                  <button role="radio" aria-checked={!hq} className={'seg-btn' + (!hq ? ' on' : '')} onClick={() => (setHqAsk(false), setQuality(false))}>
                    一般
                  </button>
                  <button role="radio" aria-checked={hq} className={'seg-btn' + (hq ? ' on' : '')} onClick={() => !hq && setHqAsk(true)}>
                    ✨ 高品質
                  </button>
                </div>
              )}
              {backing && (
                <div className="key-ctl" title="升降 Key：伴奏、導唱、灰條一起移">
                  <button className="btn icon" onClick={() => changeLiveKey(key - 1)} disabled={key <= -6} aria-label="降 Key">
                    ♭
                  </button>
                  <span>Key {key > 0 ? '+' : ''}{key}</span>
                  <button className="btn icon" onClick={() => changeLiveKey(key + 1)} disabled={key >= 6} aria-label="升 Key">
                    ♯
                  </button>
                </div>
              )}
              {!ext.present && (
                <p className="muted small sing-mode-note">
                  導唱、伴唱、升降 Key 要裝免費擴充功能（電腦 Chrome）·{' '}
                  <a href="extension.html" target="_blank" rel="noopener">
                    一分鐘裝好
                  </a>
                </p>
              )}
            </div>
          )}
          {hqAsk && (
            <div className="hq-ask">
              <strong>✨ 高品質伴奏</strong>
              <p className="small">
                {(() => {
                  const sp = aiSpeed();
                  if (!sp) return '最乾淨的去人聲，但很吃顯示卡。這台電腦還沒測過：有獨立顯示卡幾秒就好，內建顯示卡可能要先等一兩分鐘。';
                  if (sp >= 1.15) return `你的電腦算得夠快（${sp.toFixed(1)} 倍速），幾秒就能開始。`;
                  return `你的電腦算這個是 ${sp.toFixed(1)} 倍速，比歌慢：開始前要先等約 ${Math.round(aiNeed(sp, hud.dur || 240))} 秒，中間可能還會停下來等。`;
                })()}
              </p>
              <div className="row wrap">
                <button className="btn primary small" onClick={() => (setHqAsk(false), setQuality(true))}>
                  確定用高品質
                </button>
                <button className="btn small" onClick={() => setHqAsk(false)}>
                  先不要，用一般伴奏
                </button>
                <a className="small" href="bench.html" target="_blank" rel="noopener">
                  測我的電腦
                </a>
              </div>
            </div>
          )}
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
          {!guide && !liveNotes.current.has() && <p className="notice">{t('stage.mode.free.hint')}</p>}
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

          {phase === 'live' && (
            <div className="card col">
              <button className="btn primary" onClick={finish}>
                {t('stage.finish')}
              </button>
              <button className="btn" onClick={restart}>
                {t('stage.restart')}
              </button>
              {nextTitle && <p className="muted small">{t('queue.next', { title: nextTitle })}</p>}
            </div>
          )}

          {ytAny && (
            <div className="card col backing-card">
              {backingFailed && <p className="notice warn">{t('ext.failed')}</p>}
              {backing && (
                <>
                  {/* the lead player must stay visible and uncovered (YouTube rules): it sits here, not over the MV */}
                  <div className="lead-box" title={t('ext.leadTitle')}>
                    <span className="lead-label">{t('ext.lead')}</span>
                    <div className="lead-host" ref={leadRef} />
                  </div>
                  {ext.status && (
                    <small className="muted">
                      {ext.status.state === 'error'
                        ? t(ext.status.message === 'audio-blocked' ? 'ext.blocked' : 'ext.error')
                        : ext.status.state === 'loading'
                          ? t('ext.loading')
                          : ext.status.mode === 'ai'
                            ? t('ext.ai', { x: (ext.status.speed ?? 0).toFixed(1) })
                            : ext.status.mode === 'lite'
                              ? `輕量 AI 分析中（${(ext.status.speed ?? 0).toFixed(1)} 倍即時）`
                              : t('ext.classic')}
                      {ext.status.buffered !== undefined && phase === 'live' ? ' · ' + t('ext.ahead', { s: Math.max(0, ext.status.buffered).toFixed(1) }) : ''}
                    </small>
                  )}
                  <label className="field">
                    <span>
                      {t('mine.vocal')} · {Math.round(vocal * 100)}%
                    </span>
                    <input type="range" min={0} max={1} step={0.05} value={vocal} onChange={(e) => changeVocal(Number(e.target.value))} />
                  </label>
                </>
              )}
              <details className="diag">
                <summary className="small muted">{ext.present ? `擴充功能 v${ext.version}` : '擴充功能未安裝'} · 診斷</summary>
                <button
                  className="btn small diag-btn"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(diagText());
                      setDiagCopied(true);
                    } catch {
                      /* the text is shown below to copy by hand */
                    }
                  }}
                >
                  📋 {diagCopied ? t('ext.diagCopied') : t('ext.diagCopy')}
                </button>
                <pre className="diag-pre">{diagText()}</pre>
                <a className="small" href="extension.html" target="_blank" rel="noopener">
                  安裝／更新擴充功能
                </a>
              </details>
            </div>
          )}

          <details className="card col more-settings">
            <summary>⚙️ 更多設定</summary>
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

          </details>

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

        </aside>
      </div>
    </div>
  );
}
