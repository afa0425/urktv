// Dev check: guide notes from a separated vocal WAV (16-bit stereo 44.1 kHz). Prints JSON.
import * as fs from 'node:fs';
import { downmix4, phraseLines, segmentNotes, trackPitch } from '../src/separate/notes';
const b = fs.readFileSync(process.argv[2]);
const n = (b.length - 44) / 4;
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = b.readInt16LE(44 + i * 4) / 32768; R[i] = b.readInt16LE(46 + i * 4) / 32768; }
const t0 = Date.now();
const track = trackPitch(downmix4(L, R));
const notes = segmentNotes(track);
phraseLines(notes);
console.error(`notes ${notes.length}, ${Date.now() - t0} ms`);
console.log(JSON.stringify({ hop: track.hop, midi: track.midi.map((m) => (m === null ? null : Math.round(m * 100) / 100)), notes }));
