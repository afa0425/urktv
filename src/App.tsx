import { useEffect, useState } from 'react';
import type { ScoreResult } from './core/score';
import { bestOf, history, queue, recordPlay, settings, useStore, type Song } from './core/store';
import { useT } from './i18n';
import { Stage } from './ui/Stage';
import { HistoryView, QueueView, Result, SettingsView } from './ui/Views';
import { Home } from './ui/Home';
import { MineView } from './ui/Mine';
import { ExtUpdate } from './ui/ExtUpdate';

type Tab = 'home' | 'mine' | 'queue' | 'history' | 'settings';
type View =
  | { name: Tab }
  | { name: 'stage'; song: Song; key: number }
  | { name: 'result'; song: Song; result: ScoreResult; prevBest: number | null };

let stageKey = 0;

export function App() {
  const t = useT();
  const q = useStore(queue);
  const [view, setView] = useState<View>({ name: 'home' });

  const sing = (song: Song) => setView({ name: 'stage', song, key: ++stageKey });

  // links from the import page: #mine, #sing=local:<id>
  useEffect(() => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'mine') setView({ name: 'mine' });
    else if (h.startsWith('sing=local:')) sing({ id: h.slice(5), title: '' });
    if (h) window.history.replaceState(null, '', location.pathname + location.search);
  }, []);
  const singFromQueue = (song: Song, index: number) => {
    queue.set((list) => list.filter((_, i) => i !== index));
    sing(song);
  };
  const done = (result: ScoreResult, song: Song) => {
    const prevBest = bestOf(history.get(), song.id);
    // A run with no singing in it is not a score worth keeping.
    if (result.voicedSec >= 2) {
      recordPlay({ at: Date.now(), song, result, difficulty: settings.get().difficulty });
    }
    setView({ name: 'result', song, result, prevBest });
  };

  if (view.name === 'stage') {
    return (
      <Stage
        key={view.key}
        song={view.song}
        nextTitle={q[0]?.title}
        onExit={() => setView({ name: 'home' })}
        onDone={done}
      />
    );
  }

  const tabs: Tab[] = ['home', 'mine', 'queue', 'history', 'settings'];
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">♪</span>
          {t('app.name')}
        </div>
        <nav>
          {tabs.map((tab) => (
            <button
              key={tab}
              className={'tab' + (view.name === tab ? ' on' : '')}
              onClick={() => setView({ name: tab })}
            >
              {t(`nav.${tab}`)}
              {tab === 'queue' && q.length > 0 && <span className="badge">{q.length}</span>}
            </button>
          ))}
        </nav>
      </header>
      <main>
        <ExtUpdate />
        {view.name === 'home' && <Home onSing={sing} onMine={() => setView({ name: 'mine' })} />}
        {view.name === 'mine' && <MineView onSing={sing} />}
        {view.name === 'queue' && <QueueView onSing={singFromQueue} />}
        {view.name === 'history' && <HistoryView onSing={sing} />}
        {view.name === 'settings' && <SettingsView />}
        {view.name === 'result' && (
          <Result
            song={view.song}
            result={view.result}
            prevBest={view.prevBest}
            next={q[0]}
            onAgain={() => sing(view.song)}
            onNext={() => q[0] && singFromQueue(q[0], 0)}
            onHome={() => setView({ name: 'home' })}
          />
        )}
      </main>
    </div>
  );
}
