// Runs on URKTV pages: relays messages between the page and the extension.
import { EXT, PAGE, type ExtMsg, type PageMsg } from './protocol';

const toPage = (m: ExtMsg) => window.postMessage({ source: EXT, ...m }, location.origin);

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== PAGE) return;
  const m = e.data as PageMsg & { source: string };
  if (m.type === 'hello') {
    chrome.storage.local.get('consent').then((s) => toPage({ type: 'ready', version: chrome.runtime.getManifest().version, consent: !!s.consent }));
    return;
  }
  if (m.type === 'consent') {
    void chrome.storage.local.set({ consent: m.ok });
    toPage({ type: 'ready', version: chrome.runtime.getManifest().version, consent: m.ok });
    return;
  }
  chrome.runtime.sendMessage({ to: 'offscreen', from: 'page', msg: m });
});

chrome.runtime.onMessage.addListener((m: { to: string; msg: ExtMsg }) => {
  if (m.to === 'page') toPage(m.msg);
});

// announce ourselves so the page knows the extension is here
toPage({ type: 'ready', version: chrome.runtime.getManifest().version, consent: false });
chrome.storage.local.get('consent').then((s) => toPage({ type: 'ready', version: chrome.runtime.getManifest().version, consent: !!s.consent }));
