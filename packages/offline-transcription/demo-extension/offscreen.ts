// Offscreen document of the proof extension: runs the same checks as the setup
// page, in the context the product hosts the engines in during a recording.

import { runSelftest } from './selftest.ts';

declare const chrome: {
  runtime: { onMessage: { addListener(listener: (message: { target?: string; name?: string; args?: unknown }, sender: unknown, sendResponse: (response: unknown) => void) => boolean): void } };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || !message.name) return false;
  runSelftest(message.name, message.args).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: String(error) }),
  );
  return true;
});
