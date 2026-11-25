import { useEffect, useMemo, useState } from 'react';
import { listCatalog, type CatalogEntry } from '../core/catalog';
import { DEMO_ID, enqueue, history, library, useStore, type Song } from '../core/store';
import { parseVideoId, thumbUrl } from '../core/transport';
import { useT } from '../i18n';

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

export function Home({ onSing, onMine }: { onSing(song: Song): void; onMine(): void }) {
  const t = useT();
  const plays = useStore(history);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [charts, setCharts] = useState<Charts | null>(null);
  const [tab, setTab] = useState('zh');
  const [more, setMore] = useState(false);
  const [link, setLink] = useState('');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

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
  const shown = more || q ? items : items.slice(0, 10);
  const featured = catalog[0];
  const recent = library(plays).slice(0, 6);

  const singChart = (i: ChartItem) => {
    const c = prepared.get(norm(i.title));
    if (c) onSing({ id: 'cat:' + c.slug, title: `${c.title} · ${c.artist}` });
    else if (i.video) onSing({ id: i.video, title: `${i.title} · ${i.artist}` });
  };

  const fromLink = (): Song | null => {
    const id = parseVideoId(link);
    if (!id) {
      setMsg({ text: t('home.badLink'), bad: true });
      return null;
    }
    return { id, title: `YouTube · ${id}` };
  };

  return (
    <div className="page home">
      {featured ? (
        <section className="hero-card" style={{ backgroundImage: featured.video ? `url(${maxres(featured.video)})` : undefined }}>
          <div className="hero-shade" />
          <div className="hero-body">
            <div className="chips">
              <span className="chip-ai">✨ {t('home.ai.badge')}</span>
              <span className="chip-soft">{t('home.ai.lyrics')}</span>
              {featured.highest && <span className="chip-soft">{t('home.catalog.highest', { note: featured.highest })}</span>}
            </div>
            <h1 className="hero-title">{featured.title}</h1>
            <p className="hero-artist">{featured.artist}</p>
            <p className="hero-desc">{t('home.ai.desc')}</p>
            <div className="row wrap">
              <button className="btn primary big" onClick={() => onSing({ id: 'cat:' + featured.slug, title: `${featured.title} · ${featured.artist}` })}>
                🎤 {t('home.sing')}
              </button>
              <button className="btn ghost-light" onClick={onMine}>
                {t('home.mine.title')}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="hero">
          <h1>{t('home.title')}</h1>
          <p className="lead">{t('home.lead')}</p>
        </section>
      )}

      {catalog.length > 1 && (
        <section>
          <h2>✨ {t('home.catalog')}</h2>
          <ul className="tiles">
            {catalog.map((c) => (
              <li key={c.slug} className="tile">
                {c.video ? <img className="thumb" src={thumbUrl(c.video)} alt="" loading="lazy" /> : <div className="thumb thumb-demo">♪</div>}
                <div className="tile-title">
                  <strong>{c.title}</strong> · {c.artist}
                </div>
                <button className="btn primary small" onClick={() => onSing({ id: 'cat:' + c.slug, title: `${c.title} · ${c.artist}` })}>
                  {t('home.sing')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {charts && list && (
        <section className="charts">
          <div className="row between wrap">
            <h2>🔥 {t('home.charts')}</h2>
            <span className="muted small">
              {t('home.charts.source', { source: charts.source, date: charts.updated })}
            </span>
          </div>
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
          <ol className="rank-list">
            {shown.map((i) => {
              const ready = prepared.has(norm(i.title));
              return (
                <li key={i.rank + i.title} className={'rank-row' + (i.rank <= 3 ? ` top top${i.rank}` : '')}>
                  <span className="rank-no">{i.rank <= 3 ? ['🥇', '🥈', '🥉'][i.rank - 1] : i.rank}</span>
                  <Move rank={i.rank} last={i.last} />
                  {i.video ? (
                    <img className="rank-thumb" src={thumbUrl(i.video)} alt="" loading="lazy" />
                  ) : i.cover ? (
                    <img className="rank-thumb" src={i.cover} alt="" loading="lazy" />
                  ) : (
                    <div className="rank-thumb thumb-demo">♪</div>
                  )}
                  <div className="rank-info">
                    <div className="rank-title">{i.title}</div>
                    <div className="rank-artist">{i.artist}</div>
                  </div>
                  {ready ? <span className="chip-ai small">✨ {t('home.ai.short')}</span> : i.video ? <span className="chip-soft small">{t('home.charts.mv')}</span> : null}
                  <div className="rank-actions">
                    <button className="btn primary small" disabled={!ready && !i.video} onClick={() => singChart(i)}>
                      {t('home.sing')}
                    </button>
                    {i.video && (
                      <button
                        className="btn small"
                        aria-label={t('home.add')}
                        onClick={() => {
                          enqueue({ id: i.video, title: `${i.title} · ${i.artist}` });
                          setMsg({ text: `${t('home.added')}：${i.title}` });
                        }}
                      >
                        ＋
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {!q && items.length > 10 && (
            <button className="btn link" onClick={() => setMore((m) => !m)}>
              {more ? t('home.charts.less') : t('home.charts.more', { n: items.length })}
            </button>
          )}
          <p className="muted small">{t('home.charts.note')}</p>
        </section>
      )}
      {msg && <p className={'notice ' + (msg.bad ? 'warn' : 'ok')}>{msg.text}</p>}

      <section className="quick">
        <button className="quick-card" onClick={onMine}>
          <span className="quick-icon">🎛️</span>
          <strong>{t('home.mine.title')}</strong>
          <span className="muted small">{t('home.mine.desc')}</span>
        </button>
        <button className="quick-card" onClick={() => onSing({ id: DEMO_ID, title: t('stage.demoTitle') })}>
          <span className="quick-icon">🎵</span>
          <strong>{t('home.demo.title')}</strong>
          <span className="muted small">{t('home.demo.desc')}</span>
        </button>
        <form
          className="quick-card form"
          onSubmit={(e) => {
            e.preventDefault();
            const s = fromLink();
            if (s) onSing(s);
          }}
        >
          <span className="quick-icon">🔗</span>
          <strong>{t('home.paste.title')}</strong>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t('home.paste')} aria-label={t('home.paste')} inputMode="url" />
          <button className="btn small" type="submit">
            {t('home.sing')}
          </button>
        </form>
      </section>

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
    </div>
  );
}
