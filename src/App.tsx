import { useEffect, useState } from 'react';
import type { ScoreResult } from './core/score';
import { bestOf, history, queue, recordPlay, settings, useStore, type Song } from './core/store';
import { useT } from './i18n';
import { Stage } from './ui/Stage';
import { HistoryView, QueueView, Result, SettingsView } from './ui/Views';
import { Home } from './ui/Home';
import { MineView } from './ui/Mine';
import { newRoomCode, RoomPage } from './ui/Room';
import { ExtUpdate } from './ui/ExtUpdate';
import { EXT_LATEST, extOutdated, useExtension } from './core/extension';

type Tab = 'home' | 'mine' | 'queue' | 'history' | 'settings';
type View =
  | { name: Tab }
  | { name: 'stage'; song: Song; key: number }
  | { name: 'room'; code: string }
  | { name: 'result'; song: Song; result: ScoreResult; prevBest: number | null };

let stageKey = 0;

export function App() {
  const t = useT();
  const q = useStore(queue);
  const ext = useExtension();
  const [view, setView] = useState<View>({ name: 'home' });

  const sing = (song: Song) => setView({ name: 'stage', song, key: ++stageKey });

  // links from the import page: #mine, #sing=local:<id>
  useEffect(() => {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === 'mine') setView({ name: 'mine' });
    else if (h.startsWith('room=')) {
      setView({ name: 'room', code: h.slice(5).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) });
      return; // keep the room link in the address bar
    }
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

  if (view.name === 'room') {
    return (
      <RoomPage
        code={view.code}
        onExit={() => {
          window.history.replaceState(null, '', location.pathname + location.search);
          setView({ name: 'home' });
        }}
      />
    );
  }

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

  const tabs: Tab[] = ['home', 'queue', 'history', 'settings'];
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
          {/* always here: install, or update when a newer version is out */}
          <a
            className={'tab ext-tab' + (!ext.present || extOutdated(ext.version) ? ' attn' : '')}
            href="extension.html"
            target="_blank"
            rel="noopener"
            title={ext.present ? `已安裝 v${ext.version}，最新 v${EXT_LATEST}` : '還沒安裝'}
          >
            🧩 {!ext.present ? '安裝擴充功能' : extOutdated(ext.version) ? `升級擴充功能 → v${EXT_LATEST}` : `擴充功能 v${ext.version} ✓`}
          </a>
        </nav>
      </header>
      <main>
        <ExtUpdate />
        {view.name === 'home' && (
          <Home
            onSing={sing}
            onRoom={() => {
              const code = newRoomCode();
              window.history.replaceState(null, '', `${location.pathname}${location.search}#room=${code}`);
              setView({ name: 'room', code });
            }}
          />
        )}
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
