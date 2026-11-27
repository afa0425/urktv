// The high-quality backing and vocal this computer has worked out for a video, kept in this browser's
// own storage (IndexedDB of the extension). It never leaves the computer: it is the singer's own copy,
// made by the singer's own machine, so the song starts at once the next time.
const RATE = 44100;
/** A stretch counts as kept only in whole blocks of this many samples (0.1 s). */
const BLK = 4410;
const DB = 'urktv-stems';
/** Storage this cache may use; the songs sung longest ago go first. */
const MAX_BYTES = 1500 * 1024 * 1024;

const to16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));

export class Stems {
  readonly n: number;
  instL: Int16Array;
  instR: Int16Array;
  /** the vocal, mono (it is only ever a guide under the backing) */
  voc: Int16Array;
  have: Uint8Array;
  private count = 0;

  constructor(readonly video: string, readonly dur: number, from?: { instL: Int16Array; instR: Int16Array; voc: Int16Array; have: Uint8Array }) {
    this.n = Math.ceil((dur + 2) * RATE);
    this.instL = from?.instL ?? new Int16Array(this.n);
    this.instR = from?.instR ?? new Int16Array(this.n);
    this.voc = from?.voc ?? new Int16Array(this.n);
    this.have = from?.have ?? new Uint8Array(Math.ceil(this.n / BLK));
    for (const h of this.have) if (h) this.count++;
  }

  haveSecs() {
    return (this.count * BLK) / RATE;
  }

  /** Is all of [at, at+len) (samples from the video's start) kept? */
  has(at: number, len: number): boolean {
    if (at < 0 || at + len > this.n) return false;
    for (let b = Math.floor(at / BLK); b <= Math.floor((at + len - 1) / BLK); b++) if (!this.have[b]) return false;
    return true;
  }

  get(at: number, len: number): { inst: Float32Array[]; voc: Float32Array[] } | null {
    if (!this.has(at, len)) return null;
    const f = (a: Int16Array) => {
      const o = new Float32Array(len);
      for (let i = 0; i < len; i++) o[i] = a[at + i] / 32767;
      return o;
    };
    const v = f(this.voc);
    return { inst: [f(this.instL), f(this.instR)], voc: [v, v] };
  }

  put(at: number, inst: Float32Array[], voc: Float32Array[]) {
    const len = inst[0].length;
    const a = Math.max(0, at);
    const b = Math.min(this.n, at + len);
    for (let j = a; j < b; j++) {
      const i = j - at;
      this.instL[j] = to16(inst[0][i]);
      this.instR[j] = to16(inst[1][i]);
      this.voc[j] = to16((voc[0][i] + voc[1][i]) / 2);
    }
    // blocks that are now written from end to end (a block started by the piece before counts too)
    const first = Math.ceil(a / BLK);
    const last = Math.floor(b / BLK) - 1;
    const edge = Math.floor(a / BLK);
    if (edge < first && this.partial === edge && this.end === a) this.mark(edge);
    for (let k = first; k <= last; k++) this.mark(k);
    this.partial = b % BLK ? Math.floor(b / BLK) : -1;
    this.end = b;
  }
  /** The block the last piece ended inside (and where): the next piece, if it follows on, completes it. */
  private partial = -1;
  private end = -1;
  private mark(k: number) {
    if (k >= 0 && k < this.have.length && !this.have[k]) {
      this.have[k] = 1;
      this.count++;
    }
  }
}

function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('songs');
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}
const done = (tx: IDBTransaction) =>
  new Promise<void>((ok, bad) => {
    tx.oncomplete = () => ok();
    tx.onerror = () => bad(tx.error);
    tx.onabort = () => bad(tx.error);
  });
const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((ok, bad) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });

export async function loadStems(video: string): Promise<Stems | null> {
  const d = await db();
  const rec = await req(d.transaction('songs').objectStore('songs').get(video));
  if (!rec || !(rec.dur > 0)) return null;
  const k = new Stems(video, rec.dur, rec);
  if (k.instL.length !== k.n) return null; // made for another length: start over
  return k;
}

export async function saveStems(k: Stems) {
  const d = await db();
  const bytes = k.n * 6 + k.have.length;
  // make room: the songs sung longest ago go first
  const meta = d.transaction('meta').objectStore('meta');
  const [keys, vals] = await Promise.all([req(meta.getAllKeys()), req(meta.getAll())]);
  const list = keys.map((key, i) => ({ key: String(key), ...(vals[i] as { at: number; bytes: number }) })).filter((m) => m.key !== k.video).sort((a, b) => a.at - b.at);
  let total = list.reduce((a, m) => a + m.bytes, 0) + bytes;
  const tx = d.transaction(['songs', 'meta'], 'readwrite');
  while (total > MAX_BYTES && list.length) {
    const old = list.shift()!;
    tx.objectStore('songs').delete(old.key);
    tx.objectStore('meta').delete(old.key);
    total -= old.bytes;
  }
  tx.objectStore('songs').put({ dur: k.dur, instL: k.instL, instR: k.instR, voc: k.voc, have: k.have }, k.video);
  tx.objectStore('meta').put({ at: Date.now(), bytes, have: k.haveSecs(), dur: k.dur }, k.video);
  await done(tx);
}
