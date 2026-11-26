// Runs inside YouTube player frames on URKTV pages. It does NOTHING until the page starts a backing
// session ("arm"): then the audible lead player's sound goes to the extension instead of the speakers.
// The muted main player is never touched. On "disarm" the sound is handed back to the player.
import { encode16 } from './protocol';

const BLOCK = 8192;
let port: chrome.runtime.Port | null = null;
let armed = false;
let ctx: AudioContext | null = null;
let pass: GainNode | null = null; // the original sound, back to the speakers when not capturing
let hooked: HTMLVideoElement | null = null;

const report = (state: string, message?: string) =>
  chrome.runtime.sendMessage({ to: 'page-status', msg: { type: 'status', state, mode: 'tap', message } }).catch(() => {});

async function hook(video: HTMLVideoElement) {
  if (hooked === video) return;
  if (video.muted || video.volume === 0) return; // the main player: leave it alone
  const c = new AudioContext({ latencyHint: 'playback', sampleRate: 44100 });
  try {
    await c.resume();
  } catch {
    /* checked below */
  }
  if (c.state !== 'running') {
    // the browser does not let this frame play audio yet: do not take the sound (it would go silent)
    void c.close();
    report('error', 'audio-blocked');
    return;
  }
  ctx = c;
  hooked = video;
  const src = c.createMediaElementSource(video);
  pass = c.createGain();
  pass.gain.value = 0; // capturing: the original is not heard, the backing track is
  src.connect(pass);
  pass.connect(c.destination);
  const proc = c.createScriptProcessor(BLOCK, 2, 2);
  const sink = c.createGain();
  sink.gain.value = 0;
  src.connect(proc);
  proc.connect(sink);
  sink.connect(c.destination);
  proc.onaudioprocess = (e) => {
    if (!armed || video.paused || video.muted) return;
    const l = e.inputBuffer.getChannelData(0);
    const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
    const t = video.currentTime - BLOCK / c.sampleRate;
    if (!port) port = chrome.runtime.connect({ name: 'tap' });
    port.postMessage({ type: 'tap', t, rate: c.sampleRate, l: encode16(l), r: encode16(r) });
  };
  video.addEventListener('play', () => void c.resume());
  document.documentElement.dataset.urktvTap = 'lead'; // marker for testing
  report('running');
}

function disarm() {
  armed = false;
  // hand the sound back: once routed through Web Audio it can only be heard through it
  if (pass && ctx) pass.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
}

const inUrktv = (() => {
  try {
    const anc = (location as any).ancestorOrigins as DOMStringList | undefined;
    const top = anc && anc.length ? anc[anc.length - 1] : document.referrer;
    return /urktv\.afa0425\.workers\.dev|localhost/.test(String(top));
  } catch {
    return false;
  }
})();

if (inUrktv) {
  chrome.runtime.onMessage.addListener((m: { type?: string }) => {
    if (m?.type === 'arm') {
      armed = true;
      if (pass && ctx) pass.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      const v = document.querySelector('video');
      if (v) void hook(v as HTMLVideoElement);
    } else if (m?.type === 'disarm') disarm();
  });
  window.addEventListener('pagehide', disarm);
}
