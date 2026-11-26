import { useEffect, useState } from 'react';

const TIPS = [
  '🎧 戴耳機唱，評分最準',
  '🔥 高音來之前會倒數提醒',
  '💚 唱中的音符會變綠、冒火花',
  '🎤 原唱 ↔ 伴奏可以隨時切換',
  '⏩ 可以快轉、跳過前奏',
  '✨ 金色音符是高音，唱中加分',
];

/** The wait before the backing is ready: moving, with real progress instead of a guessed number. */
export function Prep({ pct, label, sub, onFast }: { pct: number | null; label: string; sub?: string; onFast?: () => void }) {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const id = window.setInterval(() => setTip((i) => (i + 1) % TIPS.length), 3200);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="overlay prep" role="status" aria-live="polite">
      <div className="prep-mic" aria-hidden="true">
        <span className="ring" />
        <span className="ring r2" />
        🎤
      </div>
      <div className="prep-eq" aria-hidden="true">
        {Array.from({ length: 7 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * 0.11}s` }} />
        ))}
      </div>
      <p className="prep-label">{label}</p>
      <div className={'prep-bar' + (pct === null ? ' busy' : '')}>
        <i style={{ width: pct === null ? undefined : `${Math.max(3, Math.min(100, pct))}%` }} />
      </div>
      <p className="prep-pct">{pct === null ? '' : `${Math.round(Math.min(99, pct))}%`}</p>
      {sub && <p className="muted small">{sub}</p>}
      <p className="prep-tip" key={tip}>
        {TIPS[tip]}
      </p>
      {onFast && (
        <button className="btn small" onClick={onFast}>
          ⚡ 改用輕量伴奏（馬上開始）
        </button>
      )}
    </div>
  );
}
