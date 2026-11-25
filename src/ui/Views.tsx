import { useEffect, useState } from 'react';
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

export function Result({ song, result, prevBest, next, onAgain, onNext, onHome }: ResultProps) {
  const t = useT();
  const none = result.voicedSec < 2;
  const score = Math.round(result.score);
  const isBest = !none && (prevBest === null || result.score > prevBest);
  return (
    <div className="page result">
      <p className="label">{t('result.title')}</p>
      <h1 className="result-song">{song.title}</h1>
      {none ? (
        <p className="notice warn">{t('result.none')}</p>
      ) : (
        <>
          <div className="result-score">
            <span className="grade">{result.grade}</span>
            <span className="score-num huge">{score}</span>
          </div>
          <p className={isBest ? 'best new' : 'best'}>
            {isBest ? t('result.newBest') : t('result.best', { n: Math.round(prevBest!) })}
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
