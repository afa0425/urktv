// Relays messages: page <-> offscreen engine, and the YouTube tap's audio blocks -> offscreen engine.
let pageTab: number | null = null;
let creating: Promise<void> | null = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const ctxs = await (chrome.runtime as any).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctxs && ctxs.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK], justification: 'Plays the backing track made from the video on this computer.' })
      .catch(() => {})
      .finally(() => (creating = null));
  }
  await creating;
}

chrome.runtime.onMessage.addListener((m: any, sender) => {
  if (m?.to === 'offscreen' && m.from === 'page') {
    if (sender.tab?.id != null) pageTab = sender.tab.id;
    void ensureOffscreen().then(() => chrome.runtime.sendMessage({ to: 'engine', msg: m.msg }));
  } else if (m?.to === 'page' && pageTab != null) {
    chrome.tabs.sendMessage(pageTab, m).catch(() => {});
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tap') return;
  port.onMessage.addListener((block) => {
    if (port.sender?.tab?.id !== pageTab) return; // only the tab that started singing
    chrome.runtime.sendMessage({ to: 'engine', msg: block }).catch(() => {});
  });
});
