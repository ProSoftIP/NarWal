// Service worker of the proof extension (board #16544): opens the setup page
// and creates the offscreen document the engines run in during a recording.

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'sw' || message.command !== 'ensure-offscreen') return false;
  (async () => {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Microphone capture and on-device transcription during a recording.',
      });
    }
    sendResponse({ ok: true });
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
