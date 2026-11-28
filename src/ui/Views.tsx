import { useEffect, useRef, useState } from 'react';
import { playSfx } from '../audio/sfx';
import { listMics } from '../audio/mic';
import { midiName } from '../audio/pitch';
import type { ScoreResult } from '../core/score';
import { DEMO_ID, history, library, queue, settings, useStore, type Lang, type Song } from '../core/store';
import { thumbUrl } from '../core/transport';
import { useT, type I18nKey } from '../i18n';

const Thumb = ({ id }: { id: string }) =>
  id === DEMO_ID || id.includes(':') ? (
    <div className="thumb thumb-demo">♪</div>
  ) : (
    <img className="thumb" src={thumbUrl(id)} alt="" loading="lazy" />
  );

// ---------- Queue ----------

export function QueueView({ onSing }: { onSing(song: Song, index: number): void }) {
  const t = useT();
  const q = useStore(queue);
  const move = (i: number, d: number) =>
    queue.set((list) => {
      const j = i + d;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  if (!q.length) return <div className="page"><p className="empty">{t('queue.empty')}</p></div>;
  return (
    <div className="page">
      <ul className="list">
        {q.map((s, i) => (
          <li key={`${s.id}-${i}`} className="list-row">
            <span className="idx">{i + 1}</span>
            <Thumb id={s.id} />
            <span className="grow title">{s.title}</span>
            <button className="btn small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('queue.up')}>
              ↑
            </button>
            <button className="btn small" onClick={() => move(i, 1)} disabled={i === q.length - 1} aria-label={t('queue.down')}>
              ↓
            </button>
            <button className="btn small" onClick={() => queue.set((l) => l.filter((_, k) => k !== i))} aria-label={t('queue.remove')}>
              ✕
            </button>
            <button className="btn primary small" onClick={() => onSing(s, i)}>
              {t('queue.play')}
            </button>
          </li>
        ))}
      </ul>
      <button className="btn link danger" onClick={() => queue.set([])}>
        {t('queue.clear')}
      </button>
    </div>
  );
}

// ---------- Result ----------

interface ResultProps {
  song: Song;
  result: ScoreResult;
  prevBest: number | null;
  next?: Song;
  onAgain(): void;
  onNext(): void;
  onHome(): void;
}

/** A title for this score: about your own singing, never a made-up comparison with others. */
function stageName(score: number): { icon: string; name: string; line: string } {
  const tiers = [
    { min: 95, icon: '👑', name: '天籟級', lines: ['這首被你唱成自己的歌了', '原唱聽到都要緊張', '整首穩到發光'] },
    { min: 88, icon: '💎', name: '麥霸認證', lines: ['KTV 包廂裡最想聽你唱', '這水準可以開演唱會了', '一開口全場安靜'] },
    { min: 78, icon: '🌟', name: '實力派', lines: ['音準和感情都在線', '再唱一次就要破紀錄了', '這首你很有一套'] },
    { min: 65, icon: '🎤', name: '潛力新星', lines: ['越唱越順了', '高音再放開一點就更猛', '這首很適合你的聲音'] },
    { min: 0, icon: '🌱', name: '暖身完成', lines: ['熟悉旋律了，下一遍會更好', '先跟著原唱多唱幾次', '勇敢開口就是第一步'] },
  ];
  const t = tiers.find((x) => score >= x.min)!;
  return { icon: t.icon, name: t.name, line: t.lines[Math.floor(Math.random() * t.lines.length)] };
}

/** A number that runs up to its value (the score reveal). */
function useCountUp(to: number, ms = 1400) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setV(to);
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, ms]);
  return v;
}

/** Paper streamers over the whole page for a few seconds. */
function Confetti({ gold }: { gold: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = innerWidth * dpr);
    const H = (cv.height = innerHeight * dpr);
    const cols = gold ? ['#ffd54a', '#fff1a8', '#ffb347', '#ff5c8a', '#ffffff'] : ['#ff5c8a', '#ffb347', '#8c64ff', '#46dcff', '#5df2b6'];
    const ps = Array.from({ length: gold ? 220 : 140 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.3,
      y: H * 0.42,
      vx: (Math.random() - 0.5) * 1500 * dpr,
      vy: (-500 - Math.random() * 1100) * dpr,
      w: (6 + Math.random() * 8) * dpr,
      r: Math.random() * 6,
      vr: (Math.random() - 0.5) * 14,
      c: cols[Math.floor(Math.random() * cols.length)],
    }));
    let raf = 0;
    let last = performance.now();
    const t0 = last;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, W, H);
      const fade = Math.max(0, 1 - (now - t0 - 3200) / 1200);
      for (const p of ps) {
        p.vy += 1700 * dpr * dt;
        p.vx *= 0.985;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.vr * dt;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.w * 0.3, p.w, p.w * 0.6);
        ctx.restore();
      }
      if (fade > 0) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [gold]);
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}

export function Result({ song, result, prevBest, next, onAgain, onNext, onHome }: ResultProps) {
  const t = useT();
  const none = result.voicedSec < 2;
  const score = Math.round(result.score);
  const isBest = !none && (prevBest === null || result.score > prevBest);
  const shown = useCountUp(none ? 0 : score);
  const party = !none && (score >= 60 || isBest);
  // the crowd, once, for a song well sung
  useEffect(() => {
    if (!party) return;
    const id = window.setTimeout(() => playSfx(score >= 85 ? 'cheer' : 'applause'), 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={'page result r2' + (score >= 85 ? ' top' : '')}>
      {party && <Confetti gold={score >= 85} />}
      <p className="label">{t('result.title')}</p>
      <h1 className="result-song">{song.title}</h1>
      {none ? (
        <p className="notice warn">{t('result.none')}</p>
      ) : (
        <>
          <div className="result-score">
            <span className="grade">{result.grade}</span>
            <span className="score-num huge">{shown}</span>
            <span className="score-unit">分</span>
          </div>
          {(() => {
            const sn = stageName(score);
            return (
              <div className="stage-name">
                <span className="sn-icon">{sn.icon}</span>
                <strong>{sn.name}</strong>
                <span className="muted">{sn.line}</span>
              </div>
            );
          })()}
          <p className={isBest ? 'best new' : 'best'}>
            {isBest
              ? prevBest === null
                ? '🎉 第一次唱這首就拿到 ' + score + ' 分！'
                : `🎉 刷新你的紀錄！比上次最佳多 ${Math.max(1, Math.round(result.score - prevBest))} 分`
              : result.score >= prevBest! - 3
                ? `🔥 離你的最佳 ${Math.round(prevBest!)} 分只差一點點`
                : t('result.best', { n: Math.round(prevBest!) })}
          </p>
          {result.extras && (
            <div className="card highlights">
              <div className="label">{t('result.titles')}</div>
              <div className="badges">
                {result.extras.titles.map((k) => (
                  <span key={k} className="badge-title">
                    🏅 {t(('result.title.' + k) as I18nKey)}
                  </span>
                ))}
              </div>
              <div className="label">{t('result.highlights')}</div>
              <ul className="hl-list">
                <li>{t('result.similarity', { n: Math.round(result.extras.similarity * 100) })}</li>
                {result.extras.bestLine && <li>{t('result.bestLine', { text: result.extras.bestLine.text })}</li>}
                {result.extras.highestHit !== null && <li>{t('result.highest', { note: midiName(result.extras.highestHit) })}</li>}
                {result.extras.highNotesTotal > 0 && (
                  <li>{t('result.highNotes', { hit: result.extras.highNotesHit, total: result.extras.highNotesTotal })}</li>
                )}
                {result.extras.maxCombo > 0 && <li>{t('result.maxCombo', { n: result.extras.maxCombo })}</li>}
              </ul>
            </div>
          )}
          <div className="card parts">
            {result.parts.map((p) => (
              <div key={p.key} className="part">
                <span>{t(('result.part.' + p.key) as I18nKey)}</span>
                <div className="bar">
                  <i style={{ width: `${Math.round(p.value * 100)}%` }} />
                </div>
                <strong>{Math.round(p.value * 100)}</strong>
              </div>
            ))}
            <p className="muted small">
              {t('result.sang', { n: Math.round(result.voicedSec) })}
              {result.lowMidi !== null && result.highMidi !== null
                ? ' · ' + t('result.range', { low: midiName(result.lowMidi), high: midiName(result.highMidi) })
                : ''}
              {result.mode === 'free' ? ' · ' + t('stage.mode.free') : ''}
            </p>
          </div>
        </>
      )}
      <div className="row center wrap">
        <button className="btn" onClick={onAgain}>
          {t('result.again')}
        </button>
        {next && (
          <button className="btn primary" onClick={onNext}>
            {t('result.nextSong')} · {next.title}
          </button>
        )}
        <button className="btn" onClick={onHome}>
          {t('result.home')}
        </button>
      </div>
    </div>
  );
}

// ---------- History ----------

function Trend({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;
  const w = 320;
  const h = 70;
  const pts = scores.map((s, i) => `${(i / (scores.length - 1)) * w},${h - 4 - (s / 100) * (h - 8)}`).join(' ');
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function HistoryView({ onSing }: { onSing(song: Song): void }) {
  const t = useT();
  const plays = useStore(history);
  const lang = useStore(settings).lang;
  if (!plays.length) return <div className="page"><p className="empty">{t('history.empty')}</p></div>;
  const lib = library(plays);
  const recent = plays.slice(0, 20).map((p) => p.result.score).reverse();
  const date = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-TW' : 'en', { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="page">
      {recent.length > 1 && (
        <section className="card">
          <div className="label">{t('history.trend', { n: recent.length })}</div>
          <Trend scores={recent} />
        </section>
      )}
      <section>
        <h2>{t('history.songs')}</h2>
        <ul className="list">
          {lib.map(({ song, best, count }) => (
            <li key={song.id} className="list-row">
              <Thumb id={song.id} />
              <span className="grow title">{song.title}</span>
              <span className="muted small">{t('history.count', { n: count })}</span>
              <strong className="pill">{Math.round(best)}</strong>
              <button className="btn primary small" onClick={() => onSing(song)}>
                {t('home.sing')}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>{t('history.plays')}</h2>
        <ul className="list">
          {plays.slice(0, 50).map((p) => (
            <li key={p.at} className="list-row">
              <span className="grade small-grade">{p.result.grade}</span>
              <span className="grow title">{p.song.title}</span>
              <span className="muted small">{date.format(p.at)}</span>
              <strong className="pill">{Math.round(p.result.score)}</strong>
            </li>
          ))}
        </ul>
      </section>
      <button
        className="btn link danger"
        onClick={() => {
          if (window.confirm(t('history.clear.confirm'))) history.set([]);
        }}
      >
        {t('history.clear')}
      </button>
    </div>
  );
}

// ---------- Settings ----------

export function SettingsView() {
  const t = useT();
  const cfg = useStore(settings);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void listMics().then(setMics);
  }, []);
  const set = (p: Partial<typeof cfg>) => settings.set((s) => ({ ...s, ...p }));
  return (
    <div className="page narrow">
      <div className="card col">
        <label className="field">
          <span>{t('settings.lang')}</span>
          <select value={cfg.lang} onChange={(e) => set({ lang: e.target.value as Lang })}>
            <option value="zh">繁體中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{t('settings.mic')}</span>
          <select value={cfg.micId} onChange={(e) => set({ micId: e.target.value })}>
            <option value="">{t('settings.mic.default')}</option>
            {mics
              .filter((m) => m.deviceId && m.deviceId !== 'default')
              .map((m, i) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `${t('settings.mic')} ${i + 1}`}
                </option>
              ))}
          </select>
          <small className="muted">{t('settings.mic.hint')}</small>
        </label>
        <label className="field">
          <span>
            {t('stage.latency')} · {cfg.latencyMs} ms
          </span>
          <input type="range" min={0} max={300} step={10} value={cfg.latencyMs} onChange={(e) => set({ latencyMs: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>{t('settings.ytKey')}</span>
          <input type="password" autoComplete="off" value={cfg.ytKey} onChange={(e) => set({ ytKey: e.target.value.trim() })} />
          <small className="muted">{t('settings.ytKey.hint')}</small>
        </label>
      </div>
      <div className="card">
        <h2>{t('settings.privacy')}</h2>
        <p className="muted">{t('settings.privacy.body')}</p>
      </div>
    </div>
  );
}
