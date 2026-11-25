import { useEffect, useState } from 'react';
import { listMics } from '../audio/mic';
import { midiName } from '../audio/pitch';
import type { ScoreResult } from '../core/score';
import { DEMO_ID, enqueue, history, library, queue, settings, useStore, type Lang, type Song } from '../core/store';
import { parseVideoId, thumbUrl } from '../core/transport';
import { useT, type I18nKey } from '../i18n';

const Thumb = ({ id }: { id: string }) =>
  id === DEMO_ID ? (
    <div className="thumb thumb-demo">♪</div>
  ) : (
    <img className="thumb" src={thumbUrl(id)} alt="" loading="lazy" />
  );

function decodeHtml(s: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

// ---------- Home ----------

export function Home({ onSing, onMine }: { onSing(song: Song): void; onMine(): void }) {
  const t = useT();
  const cfg = useStore(settings);
  const plays = useStore(history);
  const [link, setLink] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [karaokeOnly, setKaraokeOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Song[] | null>(null);
  const demoTitle = t('stage.demoTitle');

  const fromLink = (): Song | null => {
    const id = parseVideoId(link);
    if (!id) {
      setMsg({ text: t('home.badLink'), bad: true });
      return null;
    }
    return { id, title: `YouTube · ${id}` };
  };
  const added = (song: Song) => {
    enqueue(song);
    setMsg({ text: `${t('home.added')}：${song.title}` });
  };

  const search = async () => {
    if (!q.trim()) return;
    if (!cfg.ytKey) {
      setMsg({ text: t('home.search.needKey'), bad: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const u = new URL('https://www.googleapis.com/youtube/v3/search');
      const hasWord = /karaoke|ktv|伴奏|伴唱|卡拉|カラオケ|노래방/i.test(q);
      u.search = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        maxResults: '12',
        q: karaokeOnly && !hasWord ? `${q} karaoke` : q,
        key: cfg.ytKey,
      }).toString();
      const res = await fetch(u);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? String(res.status));
      setResults(
        (body.items ?? [])
          .filter((it: any) => it?.id?.videoId)
          .map((it: any) => ({ id: it.id.videoId, title: decodeHtml(it.snippet?.title ?? it.id.videoId) })),
      );
    } catch (e: any) {
      setMsg({ text: t('home.search.fail', { msg: e?.message ?? '' }), bad: true });
    } finally {
      setBusy(false);
    }
  };

  const recent = library(plays).slice(0, 6);

  return (
    <div className="page">
      <section className="hero">
        <h1>{t('home.title')}</h1>
        <p className="lead">{t('home.lead')}</p>
        <form
          className="paste"
          onSubmit={(e) => {
            e.preventDefault();
            const s = fromLink();
            if (s) onSing(s);
          }}
        >
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t('home.paste')}
            aria-label={t('home.paste')}
            inputMode="url"
          />
          <button className="btn primary" type="submit">
            {t('home.sing')}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const s = fromLink();
              if (s) {
                added(s);
                setLink('');
              }
            }}
          >
            {t('home.add')}
          </button>
        </form>
        {msg && <p className={'notice ' + (msg.bad ? 'warn' : 'ok')}>{msg.text}</p>}
      </section>

      <section className="card demo-card mine-card">
        <div>
          <h2>{t('home.mine.title')}</h2>
          <p className="muted">{t('home.mine.desc')}</p>
        </div>
        <button className="btn primary" onClick={onMine}>
          {t('nav.mine')}
        </button>
      </section>

      <section className="card demo-card">
        <div>
          <h2>{t('home.demo.title')}</h2>
          <p className="muted">{t('home.demo.desc')}</p>
        </div>
        <button className="btn primary" onClick={() => onSing({ id: DEMO_ID, title: demoTitle })}>
          {t('home.demo.go')}
        </button>
      </section>

      <section>
        <h2>{t('home.search')}</h2>
        <form
          className="paste"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('home.search.ph')} aria-label={t('home.search')} />
          <button className="btn" type="submit" disabled={busy}>
            {t('home.search.go')}
          </button>
        </form>
        <label className="check">
          <input type="checkbox" checked={karaokeOnly} onChange={(e) => setKaraokeOnly(e.target.checked)} />
          {t('home.search.karaoke')}
        </label>
        {!cfg.ytKey && <p className="muted small">{t('home.search.needKey')}</p>}
        {results && !results.length && <p className="muted">{t('home.search.none')}</p>}
        {results && results.length > 0 && (
          <ul className="tiles">
            {results.map((s) => (
              <li key={s.id} className="tile">
                <Thumb id={s.id} />
                <div className="tile-title">{s.title}</div>
                <div className="row">
                  <button className="btn primary small" onClick={() => onSing(s)}>
                    {t('home.sing')}
                  </button>
                  <button className="btn small" onClick={() => added(s)}>
                    {t('home.add')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section>
          <h2>{t('home.recent')}</h2>
          <ul className="tiles">
            {recent.map(({ song, best }) => (
              <li key={song.id} className="tile">
                <Thumb id={song.id} />
                <div className="tile-title">{song.title}</div>
                <div className="row between">
                  <span className="muted small">{t('home.best', { n: Math.round(best) })}</span>
                  <button className="btn primary small" onClick={() => onSing(song)}>
                    {t('home.sing')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>{t('home.how')}</h2>
        <ol className="steps">
          <li>{t('home.how.1')}</li>
          <li>{t('home.how.2')}</li>
          <li>{t('home.how.3')}</li>
        </ol>
      </section>
    </div>
  );
}

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
