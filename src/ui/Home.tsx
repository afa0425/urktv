import { useEffect, useMemo, useState } from 'react';
import { listCatalog, type CatalogEntry } from '../core/catalog';
import { DEMO_ID, enqueue, history, library, useStore, type Song } from '../core/store';
import { parseVideoId, thumbUrl } from '../core/transport';
import { useT } from '../i18n';
import { EXT_LATEST, extOutdated, useExtension } from '../core/extension';

interface ChartItem {
  rank: number;
  last: number | null;
  title: string;
  artist: string;
  cover: string;
  video: string;
  duration: number | null;
}
interface Charts {
  updated: string;
  source: string;
  lists: { key: string; label: string; items: ChartItem[] }[];
}

const maxres = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, '');

function Move({ rank, last }: { rank: number; last: number | null }) {
  if (!last) return <span className="mv new">NEW</span>;
  if (last > rank) return <span className="mv up">▲{last - rank}</span>;
  if (last < rank) return <span className="mv down">▼{rank - last}</span>;
  return <span className="mv same">—</span>;
}

export function Home({ onSing, onRoom }: { onSing(song: Song): void; onRoom(): void }) {
  const t = useT();
  const plays = useStore(history);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [charts, setCharts] = useState<Charts | null>(null);
  const [tab, setTab] = useState('zh');
  const [more, setMore] = useState(false);
  const [link, setLink] = useState('');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const ext = useExtension();
  const aiSpeed = Number(localStorage.getItem('urktv.aiSpeed')) || 0;

  useEffect(() => {
    void listCatalog().then(setCatalog);
    fetch(new URL('charts.json', document.baseURI).href, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => c && setCharts(c))
      .catch(() => {});
  }, []);

  // chart songs that are already prepared by the AI play the full version
  const prepared = useMemo(() => {
    const m = new Map<string, CatalogEntry>();
    for (const c of catalog) m.set(norm(c.title), c);
    return m;
  }, [catalog]);

  const list = charts?.lists.find((l) => l.key === tab) ?? charts?.lists[0];
  const items = (list?.items ?? []).filter(
    (i) => !q.trim() || norm(i.title + i.artist).includes(norm(q)),
  );
  const shown = more || q ? items : items.slice(0, 9);
  const recent = library(plays).slice(0, 6);

  const singChart = (i: ChartItem) => {
    const c = prepared.get(norm(i.title));
    if (c) onSing({ id: 'cat:' + c.slug, title: `${c.title} · ${c.artist}` });
    else if (i.video) onSing({ id: i.video, title: `${i.title} · ${i.artist}`, artist: i.artist, name: i.title });
  };


  // one box: a YouTube link sings it, anything else searches the charts
  const go = () => {
    const id = parseVideoId(link);
    if (id) return onSing({ id, title: `YouTube · ${id}` });
    setQ(link);
    document.getElementById('charts')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="page home v2">
      <section className="h-hero">
        <div className="h-neon" aria-hidden="true">
          UR<span>KTV</span>
        </div>
        <p className="h-tag">貼上任何 YouTube MV 就能唱 · 你的電腦即時去人聲 · 原唱灰條和 KTV 歌詞</p>
        <form
          className="h-search"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="貼上 YouTube 連結，或輸入歌名找排行" aria-label={t('home.paste')} />
          <button className="btn primary big" type="submit">
            🎤 開唱
          </button>
        </form>
        <button className="btn room-cta" onClick={onRoom}>
          🎉 開房同樂 · 邀朋友一起唱、開直播給大家看
        </button>
        <div className="h-status">
          {!ext.present ? (
            <>
              <span className="dot off" /> 目前只能唱原唱 MV · <a href="extension.html">裝免費擴充功能，唱伴奏版</a>（電腦 Chrome）
            </>
          ) : extOutdated(ext.version) ? (
            <>
              <span className="dot warn" /> 擴充功能 v{ext.version} 不是最新（v{EXT_LATEST}）· <a href="extension.html">去更新</a>
            </>
          ) : (
            <>
              <span className="dot on" /> 伴奏版可用 · {aiSpeed ? `你的電腦 AI ${aiSpeed.toFixed(1)} 倍速${aiSpeed >= 1.15 ? '，AI 伴奏幾秒就開始' : '，AI 伴奏要先等一下（可改快速伴奏）'}` : '第一次唱 AI 伴奏會先測你的電腦速度'}
            </>
          )}
        </div>
      </section>
      {msg && <p className={'notice ' + (msg.bad ? 'warn' : 'ok')}>{msg.text}</p>}

      {charts && list && (
        <section className="charts" id="charts">
          <div className="row between wrap">
            <h2>🔥 {t('home.charts')}</h2>
            <span className="muted small">{t('home.charts.source', { source: charts.source, date: charts.updated })}</span>
          </div>
          <div className="row between wrap">
            <div className="seg" role="tablist">
              {charts.lists.map((l) => (
                <button
                  key={l.key}
                  role="tab"
                  aria-selected={l.key === list.key}
                  className={'seg-btn' + (l.key === list.key ? ' on' : '')}
                  onClick={() => {
                    setTab(l.key);
                    setMore(false);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <input className="chart-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('home.charts.filter')} aria-label={t('home.charts.filter')} />
          </div>
          <ol className="poster-grid">
            {shown.map((i) => {
              const ready = prepared.has(norm(i.title));
              const img = i.video ? maxres(i.video) : i.cover;
              return (
                <li key={i.rank + i.title} className={'poster' + (i.rank <= 3 && !q ? ` big top${i.rank}` : '')}>
                  <button className="poster-art" disabled={!ready && !i.video} onClick={() => singChart(i)} aria-label={`${t('home.sing')} ${i.title}`}>
                    {img ? (
                      <img
                        src={img}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          // no YouTube thumbnail: the album cover instead
                          const el = e.currentTarget;
                          if (i.cover && el.src !== i.cover) el.src = i.cover;
                          else el.style.visibility = 'hidden';
                        }}
                        onLoad={(e) => {
                          // YouTube answers a missing thumbnail with a tiny grey placeholder
                          const el = e.currentTarget;
                          if (el.naturalWidth > 120) return;
                          if (i.cover && el.src !== i.cover) el.src = i.cover;
                          else el.style.visibility = 'hidden';
                        }}
                      />
                    ) : (
                      <div className="thumb-demo">♪</div>
                    )}
                    <span className="poster-rank">{i.rank}</span>
                    <span className="poster-play">🎤</span>
                    {ready && <span className="chip-ai small poster-ai">✨ AI</span>}
                  </button>
                  <div className="poster-info">
                    <div className="poster-title">{i.title}</div>
                    <div className="poster-artist">
                      <Move rank={i.rank} last={i.last} /> {i.artist}
                    </div>
                  </div>
                  {i.video && (
                    <button
                      className="btn small poster-add"
                      aria-label={t('home.add')}
                      title={t('home.add')}
                      onClick={() => {
                        enqueue({ id: i.video, title: `${i.title} · ${i.artist}`, artist: i.artist, name: i.title });
                        setMsg({ text: `${t('home.added')}：${i.title}` });
                      }}
                    >
                      ＋
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
          {!q && items.length > 9 && (
            <button className="btn link" onClick={() => setMore((m) => !m)}>
              {more ? t('home.charts.less') : t('home.charts.more', { n: items.length })}
            </button>
          )}
        </section>
      )}

      {recent.length > 0 && (
        <section>
          <h2>{t('home.recent')}</h2>
          <ul className="tiles">
            {recent.map(({ song, best }) => (
              <li key={song.id} className="tile">
                {song.id === DEMO_ID || song.id.includes(':') ? <div className="thumb thumb-demo">♪</div> : <img className="thumb" src={thumbUrl(song.id)} alt="" loading="lazy" />}
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

      <section className="quick small-quick">
        <button className="quick-card" onClick={() => onSing({ id: DEMO_ID, title: t('stage.demoTitle') })}>
          <span className="quick-icon">🎵</span>
          <strong>{t('home.demo.title')}</strong>
          <span className="muted small">{t('home.demo.desc')}</span>
        </button>
      </section>
    </div>
  );
}
