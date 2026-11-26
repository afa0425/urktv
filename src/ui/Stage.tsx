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
import { LiveNotes } from '../core/liveNotes';
import { ExtUpdate } from './ExtUpdate';
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

/** Synced lyrics for a YouTube title from LRCLIB (free, public). Line timing only. */
/** About how long a lyric line takes to sing (web lyrics only give when it starts). */
const sungDur = (text: string) => Math.max(1, text.replace(/\s/g, '').length * 0.33 + 0.4);

async function findLyrics(videoTitle: string): Promise<{ lrc: string; name: string } | null> {
  const inner = /[【「《\[](.+?)[】」》\]]/.exec(videoTitle)?.[1];
  const clean = videoTitle
    .replace(/[【「《\[(（].*?(official|mv|m\/v|music video|lyric|歌詞|動態|官方|完整版|高音質|ktv|伴奏|karaoke|4k|hd).*?[】」》\])）]/gi, ' ')
    .replace(/official\s*(music\s*)?video|music video|lyrics? video|\bmv\b|\bm\/v\b|官方|完整版|動態歌詞|歌詞版?|高音質/gi, ' ')
    .replace(/[|｜]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const queries = [...new Set([clean, inner && `${clean.split(/[-–—]/)[0]} ${inner}`, inner].filter(Boolean) as string[])];
  for (const q of queries) {
    try {
      const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      const list = ((await r.json()) as any[]).filter((x) => x.syncedLyrics);
      if (list.length) return { lrc: list[0].syncedLyrics, name: `${list[0].artistName} – ${list[0].trackName}` };
    } catch {
      /* offline or blocked */
    }
  }
  return null;
}

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
  const vocalRef = useRef(0);
  vocalRef.current = vocal;
  const base = useRef<{ inst: Float32Array[]; voc: Float32Array[] } | null>(null);
  const video = useRef<YouTubeTransport | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ktvRef = useRef<HTMLDivElement>(null);
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
  // AI backing (clean, may need a head start) or fast backing (classic cut: starts at once, duller)
  const [bmode, setBmode] = useState<'ai' | 'fast'>(() => (localStorage.getItem('urktv.bmode') === 'fast' ? 'fast' : 'ai'));
  const bmodeRef = useRef(bmode);
  bmodeRef.current = bmode;
  // any YouTube song can get the live backing track: library songs, and links pasted on Home
  const ytPlain = !own && !isDemo;
  const ytAny = ytCat || ytPlain;
  const backing = ytAny && ext.present && ext.consent && wantBacking;
  const [backingFailed, setBackingFailed] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [lyricsNote, setLyricsNote] = useState('');
  const triedLyrics = useRef('');
  useEffect(() => {
    if (!ytPlain || saved || !title || title.startsWith('YouTube · ') || triedLyrics.current === title) return;
    triedLyrics.current = title;
    let off = false;
    findLyrics(title).then((hit) => {
      if (off) return;
      if (!hit) return setLyricsNote(t('stage.lyricsNone'));
      charts.set((c) => (c[song.id] ? c : { ...c, [song.id]: { raw: hit.lrc, kind: 'lrc', offsetMs: 0, transpose: 0 } }));
      setLyricsNote(t('stage.lyricsFound', { name: hit.name }));
    });
    return () => {
      off = true;
    };
  }, [ytPlain, saved, title, song.id]);
  const [diagCopied, setDiagCopied] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const mainSince = useRef(0);
  const manualLyrics = useRef(false);
  const lastRestart = useRef(0);
  const [hold, setHold] = useState<number | null>(null); // seconds of backing still to prepare
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
        const md = MODELS.kara2;
        const ai = bmodeRef.current === 'ai' && !extRef.current.fellBack;
        extPost({ type: 'start', lead: LEAD, vocal: vocalRef.current, mode: ai ? 'ai' : 'classic', modelUrl: MODEL_BASE + md.file, ortBase: ORT_BASE, model: 'kara2' });
        rebuffering.current = true;
        tr.main.pause();
        tr.seek(tr.time(), true);
      }
      if (st?.mode === 'ai' && (st.speed ?? 0) > 0) localStorage.setItem('urktv.aiSpeed', String(st.speed));
      const aiOn = bmodeRef.current === 'ai' && !extRef.current.fellBack && st?.mode !== 'classic';
      const left = Math.max(0, (tr.duration() || 300) - tr.time());
      // the lead may run as far ahead as the AI needs; the fast backing needs 2 s
      const want = aiOn ? aiNeed(aiSpeed() || 1, left) : 2;
      if (tr.started) tr.ahead = Math.max(2, want);
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
        const left = rebuffering.current && !tr.lead.ended() ? Math.max(1, Math.ceil(Math.min(want, 600) - b)) : null;
        setHold((h) => (h === left ? h : left));
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

  /** This computer's AI speed (× real time): measured now, or remembered from last time. */
  const aiSpeed = () => {
    const st = extRef.current.status;
    if (st?.mode === 'ai' && (st.speed ?? 0) > 0) return st.speed!;
    return Number(localStorage.getItem('urktv.aiSpeed')) || 0;
  };
  /** Seconds of AI backing to have ready so it lasts `left` seconds of song at speed sp. */
  const aiNeed = (sp: number, left: number) => (sp >= 1.15 ? 8 : Math.min(600, left * (1 / sp - 1) + 8));

  /** The singer picks: original / fast backing / AI backing (both made on their own computer). */
  const pickMode = (m: 'orig' | 'fast' | 'ai') => {
    if (m === 'orig') {
      if (phase === 'live' && backing) changeVocal(1);
      else setWantBacking(false);
      return;
    }
    localStorage.setItem('urktv.bmode', m);
    setBmode(m);
    if (!backing) {
      setWantBacking(true);
      if (phase === 'live') setPhase('ready'); // the players are rebuilt: press start again
      return;
    }
    changeVocal(0);
    if (phase === 'live' && m !== bmode) {
      extRef.current.fellBack = false;
      const md = MODELS.kara2;
      extPost({ type: 'setmode', mode: m === 'ai' ? 'ai' : 'classic', modelUrl: MODEL_BASE + md.file, ortBase: ORT_BASE, model: 'kara2' } as any);
      const tr = transport.current;
      if (tr instanceof DualTransport && !tr.started) tr.ahead = 2; // still counting down: just wait less
      else if (tr instanceof DualTransport) {
        tr.ahead = 2;
        // the backing for the new choice starts where the picture is now: the picture waits for it
        rebuffering.current = true;
        tr.main.pause();
        tr.seek(tr.time(), true);
      }
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
      // the lead player starts first; the AI gets LEAD seconds of head start
      const m = MODELS.kara2;
      extRef.current.fellBack = false;
      const ai = bmodeRef.current === 'ai';
      extPost({ type: 'start', lead: LEAD, vocal, mode: ai ? 'ai' : 'classic', modelUrl: MODEL_BASE + m.file, ortBase: ORT_BASE, model: 'kara2' });
      let started = false;
      const t0 = performance.now();
      // how much backing to prepare before the picture starts: fast backing 2 s; AI enough that this
      // computer, at its measured speed, is never caught up before the end of the song
      const need = () => {
        if (bmodeRef.current !== 'ai' || extRef.current.fellBack) return 2;
        const sp = aiSpeed();
        if (!sp) return performance.now() - t0 > 40000 ? -1 : LEAD; // model still loading
        return aiNeed(sp, tr.duration() || 300);
      };
      tr.startStaggered(
        () => {
          started = true;
          setCountdown(0);
        },
        () => {
          const st = extRef.current.status;
          let n = need();
          if (n === -1) {
            // the AI never answered on this computer: fast backing, so the song can start
            extPost({ type: 'setmode', mode: 'classic' });
            extRef.current.fellBack = true;
            n = 2;
          }
          tr.ahead = n;
          return (st?.buffered ?? 0) >= n - 0.5 && tr.lead.time() >= n - 0.5;
        },
      );
      setCountdown(LEAD);
      const cd = window.setInterval(() => {
        if (started) return window.clearInterval(cd);
        const n = Math.max(2, need());
        const b = extRef.current.status?.buffered ?? 0;
        setCountdown(Math.max(1, Math.ceil(n - b)));
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
  /** KTV way to fix the timing: press when a line starts singing; that line snaps to now. */
  const alignLyrics = () => {
    const tr = transport.current;
    if (!tr || !chart?.lines.length) return;
    manualLyrics.current = true;
    const now = tr.time();
    const tc = now - live.current.offset;
    let best = chart.lines[0];
    for (const l of chart.lines) if (Math.abs(l.start - tc) < Math.abs(best.start - tc)) best = l;
    // the line about to start or just started, not one far away
    patchChart({ offsetMs: Math.round((now - best.start) * 1000) });
  };
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

  return (
    <div className="stage">
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
            {phase === 'live' && backing && hold !== null && (
              <div className="overlay hold">
                <p>
                  {bmode === 'ai' && !extRef.current.fellBack ? '✨ AI 伴奏準備中' : '⚡ 伴奏準備中'}，還要約 <strong>{hold}</strong> 秒
                </p>
                {bmode === 'ai' && aiSpeed() > 0 && aiSpeed() < 1.15 && (
                  <p className="muted small">你的電腦算 AI 是 {aiSpeed().toFixed(1)} 倍速，比歌慢，所以要先多算一段</p>
                )}
                {bmode === 'ai' && (
                  <button className="btn primary" onClick={() => pickMode('fast')}>
                    ⚡ 改用快速伴奏（馬上繼續）
                  </button>
                )}
              </div>
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
          {ytAny && ext.present && ext.consent && !backingFailed && (
            <div className="sing-mode">
              <div className="seg" role="radiogroup">
                {(['orig', 'fast', 'ai'] as const).map((m) => {
                  const on = m === 'orig' ? !backing || vocal >= 0.5 : backing && vocal < 0.5 && bmode === m;
                  return (
                    <button key={m} role="radio" aria-checked={on} className={'seg-btn' + (on ? ' on' : '')} onClick={() => pickMode(m)}>
                      {m === 'orig' ? '🎤 原唱' : m === 'fast' ? '⚡ 快速伴奏' : '✨ AI 伴奏'}
                    </button>
                  );
                })}
              </div>
              <p className="muted small sing-mode-note">
                {!backing || vocal >= 0.5
                  ? '播原本的 MV 聲音'
                  : bmode === 'fast'
                    ? '你的電腦即時去人聲：馬上開始，人聲會有點悶'
                    : (() => {
                        const sp = aiSpeed();
                        if (!sp) return '你的電腦用 AI 即時去人聲：最乾淨，第一次會先測你的電腦速度';
                        const w = Math.round(aiNeed(sp, hud.dur || 240));
                        return `你的電腦用 AI 即時去人聲：最乾淨 · 你的電腦 ${sp.toFixed(1)} 倍速` + (sp >= 1.15 ? '，幾秒就開始' : `，開始前要先等約 ${w} 秒`);
                      })()}
              </p>
            </div>
          )}
          <div className="ktv" ref={ktvRef} aria-live="off">
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
                      (line.parts.length ? line.parts : [{ start: line.start, end: Math.min(line.end, line.start + sungDur(line.text)), text: line.text }]).map((p, k) => (
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

          {phase === 'live' && !isDemo && (
            <div className="seekbar">
              <button className="btn small" onClick={() => seekTo(hud.time - 10)} aria-label="-10">
                ⏪ 10
              </button>
              <span className="seek-time">{fmt(drag ?? hud.time)}</span>
              <input
                className="seek"
                type="range"
                min={0}
                max={Math.max(1, Math.floor(hud.dur))}
                step={1}
                value={drag ?? Math.floor(hud.time)}
                aria-label={t('stage.seek')}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={() => drag !== null && (seekTo(drag), setDrag(null))}
                onKeyUp={() => drag !== null && (seekTo(drag), setDrag(null))}
                onBlur={() => setDrag(null)}
              />
              <span className="seek-time">{fmt(hud.dur)}</span>
              <button className="btn small" onClick={() => seekTo(hud.time + 10)} aria-label="+10">
                10 ⏩
              </button>
              {firstVoice() !== null && hud.time < (firstVoice() ?? 0) && (
                <button className="btn small" onClick={() => seekTo(firstVoice()!)}>
                  {t('stage.skipIntro')}
                </button>
              )}
            </div>
          )}
          {lyricsNote && <p className="muted small lyric-src">{lyricsNote}</p>}
          {countdown > 0 && (
            <div className="notice ok countdown">
              🎛️ {t('ext.countdown', { n: countdown })}
              {bmode === 'ai' && countdown > 5 && (
                <button className="btn small primary" style={{ marginLeft: 10 }} onClick={() => pickMode('fast')}>
                  ⚡ 改用快速伴奏（馬上開始）
                </button>
              )}
            </div>
          )}
          {saved?.kind === 'lrc' && phase === 'live' && (
            <div className="row center lyric-nudge">
              <button className="btn small" onClick={() => ((manualLyrics.current = true), patchChart({ offsetMs: (saved.offsetMs ?? 0) - 500 }))}>
                {t('stage.lyricsEarlier')}
              </button>
              <button className="btn small primary" onClick={alignLyrics}>
                {t('stage.lyricsTap')}
              </button>
              <span className="muted small">{((saved.offsetMs ?? 0) / 1000).toFixed(1)} s</span>
              <button className="btn small" onClick={() => ((manualLyrics.current = true), patchChart({ offsetMs: (saved.offsetMs ?? 0) + 500 }))}>
                {t('stage.lyricsLater')}
              </button>
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

          {ytAny && (
            <div className="card col">
              <div className="label">{t('ext.title')}</div>
              {backingFailed && <p className="notice warn">{t('ext.failed')}</p>}
              {/* always here, even when the extension is not detected: that is the case to diagnose */}
              <button
                className="btn small diag-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(diagText());
                    setDiagCopied(true);
                  } catch {
                    setDiagOpen(true);
                  }
                }}
              >
                📋 {diagCopied ? t('ext.diagCopied') : t('ext.diagCopy')}
              </button>
              <button className="btn link small" onClick={() => setDiagOpen((o) => !o)}>
                {diagOpen ? t('ext.diagHide') : t('ext.diagShow')}
              </button>
              {diagOpen && <pre className="diag-pre">{diagText()}</pre>}
              <a className="small" href="extension.html" target="_blank" rel="noopener">
                {ext.present ? `擴充功能 v${ext.version}` : '安裝擴充功能'}
              </a>
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
