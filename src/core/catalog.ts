// Songs prepared on the server by pipeline/ (AI-separated backing + original vocal, guide notes,
// per-character lyrics), published as static files under catalog/.
import type { Chart, LyricLine, Note } from './chart';

export interface CatalogEntry {
  slug: string;
  title: string;
  artist: string;
  duration: number;
  video: string;
  highest?: string;
  key?: { tonic: string; mode: string };
}

export interface Highlight {
  type: 'high_note';
  start: number;
  end: number;
  peak: string;
  notes: number[];
}

export interface CatalogPackage {
  slug: string;
  title: string;
  artist: string;
  duration: number;
  video: { id: string; offset: number } | null;
  key?: { tonic: string; mode: string };
  range?: { lowest: string; highest: string };
  notes: { s: number; e: number; m: number; t: string[] }[];
  curve: { hop: number; midi: (number | null)[] };
  lyrics: { s: number; e: number; text: string; chars: [number, number, string][] }[];
  highlights: Highlight[];
  breaths: number[];
}

/** Everything the stage needs for a layered song (catalog or the user's own). */
export interface Layered {
  title: string;
  notes: Note[];
  lines: LyricLine[];
  inst: Float32Array[];
  voc: Float32Array[];
  rate: number;
  curve?: CatalogPackage['curve'];
  highlights?: Highlight[];
  video?: { id: string; offset: number } | null;
}

/** For songs without prepared highlights: the highest sung notes become golden "high note" moments. */
export function computeHighlights(notes: Note[]): Highlight[] {
  const held = notes.filter((n) => n.end - n.start >= 0.15);
  if (!held.length) return [];
  const top = Math.max(...held.map((n) => n.midi));
  const out: Highlight[] = [];
  notes.forEach((n, i) => {
    if (n.midi < top - 1 || n.end - n.start < 0.15) return;
    n.kind = 'golden';
    const last = out[out.length - 1];
    if (last && n.start - last.end < 2) {
      last.end = n.end;
      last.notes.push(i);
    } else out.push({ type: 'high_note', start: n.start, end: n.end, peak: '', notes: [i] });
  });
  return out;
}

const base = () => new URL('catalog/', document.baseURI).href;
export const isCatalog = (id: string) => id.startsWith('cat:');

export async function listCatalog(): Promise<CatalogEntry[]> {
  try {
    const r = await fetch(base() + 'index.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    return ((await r.json()).songs ?? []) as CatalogEntry[];
  } catch {
    return [];
  }
}

/** Turns a package into stage data: notes in the highlights become golden, lyrics give the lines. */
export function packageToChart(p: CatalogPackage): Chart {
  const golden = new Set(p.highlights.flatMap((h) => h.notes));
  const lines: LyricLine[] = p.lyrics.map((l) => ({
    start: l.s,
    end: l.e,
    text: l.text,
    parts: l.chars.map(([s, e, text]) => ({ start: s, end: e, text })),
  }));
  const notes: Note[] = p.notes.map((n, i) => {
    let line = lines.findIndex((l) => n.s >= l.start - 0.05 && n.s < l.end + 0.05);
    if (line < 0) line = 0;
    return { start: n.s, end: n.e, midi: Math.round(n.m), text: '', kind: golden.has(i) ? 'golden' : 'normal', line };
  });
  return { title: p.title, artist: p.artist, notes, lines, hasPitch: notes.length > 0 };
}

async function decode(url: string, ctx: BaseAudioContext): Promise<Float32Array[]> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const buf = await ctx.decodeAudioData(await r.arrayBuffer());
  return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
}

export async function loadCatalog(slug: string): Promise<Layered> {
  const dir = base() + encodeURIComponent(slug) + '/';
  const r = await fetch(dir + 'song.json');
  if (!r.ok) throw new Error(`song ${slug}: ${r.status}`);
  const pkg = (await r.json()) as CatalogPackage;
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const [inst, voc] = await Promise.all([decode(dir + 'instrumental.mp3', ctx), decode(dir + 'guide.mp3', ctx)]);
    const chart = packageToChart(pkg);
    return {
      title: `${pkg.title}${pkg.artist ? ' · ' + pkg.artist : ''}`,
      notes: chart.notes,
      lines: chart.lines,
      inst: inst.length > 1 ? inst : [inst[0], inst[0]],
      voc: [voc[0]],
      rate: ctx.sampleRate,
      curve: pkg.curve,
      highlights: pkg.highlights,
      video: pkg.video,
    };
  } finally {
    void ctx.close();
  }
}
