import { useEffect, useState } from 'react';
import type { Song } from '../core/store';
import { deleteLocal, listLocal, type LocalMeta } from '../separate/db';
import { useT } from '../i18n';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "My songs": songs the user imported and separated in this browser. */
export function MineView({ onSing }: { onSing(song: Song): void }) {
  const t = useT();
  const [list, setList] = useState<LocalMeta[] | null>(null);
  const load = () => listLocal().then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="page">
      <section className="card demo-card">
        <div>
          <h2>{t('mine.title')}</h2>
          <p className="muted">{t('mine.lead')}</p>
        </div>
        <a className="btn primary" href="import.html">
          {t('mine.open')}
        </a>
      </section>
      {list && !list.length && <p className="empty">{t('mine.empty')}</p>}
      {list && list.length > 0 && (
        <ul className="list">
          {list.map((m) => (
            <li key={m.id} className="list-row">
              <div className="thumb thumb-demo">♪</div>
              <span className="grow title">{m.title}</span>
              <span className="muted small">
                {fmt(m.duration)} · {t('mine.notes', { n: m.noteCount })}
              </span>
              <button
                className="btn small"
                onClick={async () => {
                  if (!window.confirm(t('mine.deleteConfirm', { title: m.title }))) return;
                  await deleteLocal(m.id);
                  void load();
                }}
              >
                {t('mine.delete')}
              </button>
              <button className="btn primary small" onClick={() => onSing({ id: m.id, title: m.title })}>
                {t('home.sing')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
