// The user's own imported songs, kept in this browser (IndexedDB): tracks + guide notes. Nothing is uploaded.
import type { LyricLine, Note } from '../core/chart';

export interface LocalMeta {
  id: string; // "local:<uuid>"
  title: string;
  createdAt: number;
  duration: number;
  noteCount: number;
  model: string;
}

export interface LocalSong extends LocalMeta {
  sampleRate: number;
  notes: Note[];
  lines: LyricLine[];
  /** Backing track, 16-bit interleaved stereo. */
  inst: ArrayBuffer;
  /** Original lead vocal (the guide), 16-bit mono. */
  voc: ArrayBuffer;
}

const DB = 'hising';
const META = 'meta';
const SONGS = 'songs';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const r = fn(t);
        t.oncomplete = () => {
          db.close();
          resolve(r ? (r.result as T) : (undefined as T));
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('aborted'));
      }),
  );
}

export const isLocal = (id: string) => id.startsWith('local:');

export async function saveLocal(song: LocalSong): Promise<void> {
  const { inst: _i, voc: _v, sampleRate: _s, notes: _n, lines: _l, ...meta } = song;
  await tx([META, SONGS], 'readwrite', (t) => {
    t.objectStore(SONGS).put(song);
    t.objectStore(META).put(meta);
  });
}

export const listLocal = () =>
  tx<LocalMeta[]>([META], 'readonly', (t) => t.objectStore(META).getAll()).then((l) => l.sort((a, b) => b.createdAt - a.createdAt));

export const getLocal = (id: string) => tx<LocalSong | undefined>([SONGS], 'readonly', (t) => t.objectStore(SONGS).get(id));

export const deleteLocal = (id: string) =>
  tx([META, SONGS], 'readwrite', (t) => {
    t.objectStore(SONGS).delete(id);
    t.objectStore(META).delete(id);
  });

// ---- PCM packing ----

export function toInt16(chs: Float32Array[]): ArrayBuffer {
  const n = chs[0].length;
  const c = chs.length;
  const out = new Int16Array(n * c);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      const v = Math.max(-1, Math.min(1, chs[k][i]));
      out[i * c + k] = Math.round(v * 32767);
    }
  }
  return out.buffer;
}

export function fromInt16(buf: ArrayBuffer, channels: number): Float32Array[] {
  const a = new Int16Array(buf);
  const n = a.length / channels;
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let k = 0; k < channels; k++) out[k][i] = a[i * channels + k] / 32767;
  return out;
}
