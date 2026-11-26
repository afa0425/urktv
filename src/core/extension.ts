// The URKTV extension (Chrome, computer): makes the backing track on this computer from the MV
// that is playing. This module talks to it through window messages.
import { useSyncExternalStore } from 'react';

export interface ExtStatus {
  state: 'loading' | 'running' | 'fallback' | 'error';
  mode?: string;
  speed?: number;
  buffered?: number;
  message?: string;
}
export interface ExtState {
  present: boolean;
  consent: boolean;
  version?: string;
  status?: ExtStatus;
}

let state: ExtState = { present: false, consent: false };
const subs = new Set<() => void>();
const set = (p: Partial<ExtState>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'urktv-ext') return;
    const m = e.data;
    if (m.type === 'ready') set({ present: true, consent: !!m.consent, version: m.version });
    else if (m.type === 'status') {
      if (m.mode === 'tap' && m.state !== 'error') return; // the player frame just confirmed it is connected
      set({ status: { state: m.state, mode: m.mode, speed: m.speed, buffered: m.buffered, message: m.message } });
    }
  });
  // ask: the extension answers if it is installed
  setTimeout(() => extPost({ type: 'hello' }), 0);
}

export function extPost(m: Record<string, unknown>) {
  window.postMessage({ source: 'urktv-page', ...m }, location.origin);
}

export const useExtension = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );

/** How far the hidden-lead player runs ahead of the visible one (seconds): room for the AI to work. */
export const LEAD = 9;
