// Runs inside YouTube player frames on URKTV pages. When this player is audible (the "lead" player),
// its audio is routed into the extension instead of the speakers. The visible main player is muted,
// so it never sends anything. Nothing is recorded or stored.
import { encode16 } from './protocol';

const BLOCK = 8192;
let port: chrome.runtime.Port | null = null;
let hooked: HTMLVideoElement | null = null;

function hook(video: HTMLVideoElement) {
  if (hooked === video) return;
  hooked = video;
  const ctx = new AudioContext({ latencyHint: 'playback' });
  const src = ctx.createMediaElementSource(video); // from now on the element is heard only through us
  const proc = ctx.createScriptProcessor(BLOCK, 2, 2);
  const silent = ctx.createGain();
  silent.gain.value = 0; // keep the graph pulling without making the original audible
  src.connect(proc);
  proc.connect(silent);
  silent.connect(ctx.destination);
  proc.onaudioprocess = (e) => {
    if (video.paused || video.muted || video.volume === 0) return; // the muted main player sends nothing
    const l = e.inputBuffer.getChannelData(0);
    const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
    // time of this block's first sample (the block was captured just before now)
    const t = video.currentTime - BLOCK / ctx.sampleRate;
    if (!port) port = chrome.runtime.connect({ name: 'tap' });
    port.postMessage({ type: 'tap', t, rate: ctx.sampleRate, l: encode16(l), r: encode16(r) });
  };
  video.addEventListener('play', () => void ctx.resume());
}

// only act when the frame is embedded in URKTV (the extension is told by the top page's origin)
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
  const find = () => {
    const v = document.querySelector('video');
    if (v) hook(v as HTMLVideoElement);
  };
  new MutationObserver(find).observe(document.documentElement, { childList: true, subtree: true });
  find();
}
