// What this computer has already worked out for a song (the vocal's pitch, from which the gray bars
// and the lyric timing come), kept in IndexedDB so the next time it is all there from the start.
const DB = 'urktv-songs';
const STORE = 'pitch';
/** Bumped when the analysis changes: older copies are ignored. */
const V = 'v2:';

function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}

export interface PitchCache {
  hop: number;
  /** first frame index */
  k0: number;
  /** midi × 10 per frame, 0 = silent */
  data: Uint16Array;
}

export async function loadPitch(videoId: string): Promise<PitchCache | null> {
  try {
    const d = await db();
    return await new Promise((ok) => {
      const r = d.transaction(STORE).objectStore(STORE).get(V + videoId);
      r.onsuccess = () => ok((r.result as PitchCache) ?? null);
      r.onerror = () => ok(null);
    });
  } catch {
    return null;
  }
}

export async function savePitch(videoId: string, c: PitchCache) {
  try {
    const d = await db();
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(c, V + videoId);
  } catch {
    /* private mode or full: it is only a speed-up */
  }
}
