import { useSyncExternalStore } from 'react';
import type { ChartKind } from './chart';
import type { Difficulty, ScoreResult } from './score';

// Everything is kept in this browser's localStorage: no account, no server.

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

function persisted<T>(key: string, initial: T): Store<T> {
  let value = initial;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      value = Array.isArray(initial) || typeof initial !== 'object' ? parsed : { ...initial, ...parsed };
    }
  } catch {
    /* private mode or corrupt data: start fresh */
  }
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage full or blocked: keep working in memory */
      }
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get);

export type Lang = 'zh' | 'en';

export interface Settings {
  lang: Lang;
  difficulty: Difficulty;
  /** Delay between singing and the app hearing it (mic + analysis), in ms. */
  latencyMs: number;
  micId: string;
  /** Optional YouTube Data API key, only used for the in-app search. */
  ytKey: string;
  guideVolume: number;
  /** Hear your own voice (with echo) while singing. */
  monitor: boolean;
  monitorVol: number;
  echo: number;
}

export const DEMO_ID = 'demo';

export interface Song {
  /** YouTube video id, or DEMO_ID for the built-in warm-up. */
  id: string;
  title: string;
}

export interface Play {
  at: number;
  song: Song;
  result: ScoreResult;
  difficulty: Difficulty;
}

export interface SavedChart {
  raw: string;
  kind: ChartKind;
  /** Shift of the chart against this video, in ms (the file may be timed to a different cut). */
  offsetMs: number;
  /** Key change in semitones for the target melody. */
  transpose: number;
  /** Found automatically on the web (version of the search that found it), and what it was. */
  auto?: number;
  name?: string;
}

export const settings = persisted<Settings>('hs.settings', {
  lang: (typeof navigator !== 'undefined' ? navigator.language : 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en',
  difficulty: 'normal',
  latencyMs: 80,
  micId: '',
  ytKey: '',
  guideVolume: 0.5,
  monitor: true,
  monitorVol: 0.8,
  echo: 0.3,
});
export const queue = persisted<Song[]>('hs.queue', []);
export const history = persisted<Play[]>('hs.history', []);
export const charts = persisted<Record<string, SavedChart>>('hs.charts', {});

export function enqueue(song: Song, front = false) {
  queue.set((q) => (front ? [song, ...q] : [...q, song]));
}

export function recordPlay(p: Play) {
  history.set((h) => [p, ...h].slice(0, 300));
}

export function renameSong(id: string, title: string) {
  const fix = (s: Song) => (s.id === id && s.title !== title ? { ...s, title } : s);
  queue.set((q) => q.map(fix));
}

export function bestOf(plays: Play[], id: string): number | null {
  let best: number | null = null;
  for (const p of plays) if (p.song.id === id && (best === null || p.result.score > best)) best = p.result.score;
  return best;
}

/** Distinct songs from the history, most recent first. */
export function library(plays: Play[]): { song: Song; best: number; count: number; last: number }[] {
  const map = new Map<string, { song: Song; best: number; count: number; last: number }>();
  for (const p of plays) {
    const e = map.get(p.song.id);
    if (!e) map.set(p.song.id, { song: p.song, best: p.result.score, count: 1, last: p.at });
    else {
      e.best = Math.max(e.best, p.result.score);
      e.count++;
    }
  }
  return [...map.values()];
}
