// NarWal's Options page (board #16785): the microphone every recording uses,
// with the test bar. Chrome opens it from the extension's menu ("Options")
// and the popup links to it.
import { adoptCss, h } from '../../../recorder-ui/src/dom.js';
import { narwalLogo } from '../../../recorder-ui/src/logo.js';
import { mountMicPanel } from '../../../recorder-ui/src/mic-panel.js';
import { createPrefs } from '../../../recorder-ui/src/prefs.js';
import { START_CSS } from '../../../recorder-ui/src/styles.js';
import { guardThisPage } from './page-guard.js';

// A new build in the folder waits while this page is in use (board #17009).
guardThisPage();

const PAGE_CSS = `
.nw-start.nw-options { max-width: 640px; padding: 24px; }
.nw-options .nw-section { margin-top: 8px; }
`;

async function fix(state) {
  if (state === 'denied') {
    // A blocked microphone is changed in NarWal's site settings.
    await chrome.tabs.create({ url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}` });
    return;
  }
  // This page is visible, so Chrome can show its prompt here.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // The panel reads the new state and says what is wrong.
  }
}

function main() {
  adoptCss(document, START_CSS);
  adoptCss(document, PAGE_CSS);
  const section = h(document, 'div', { class: 'nw-section' });
  const page = h(
    document,
    'main',
    { class: 'nw-start nw-options', lang: 'en' },
    h(
      document,
      'header',
      { class: 'nw-head' },
      narwalLogo(document, 32),
      h(document, 'div', { class: 'nw-brand' }, h(document, 'h1', { text: 'NarWal options' }), h(document, 'span', { class: 'nw-tagline', text: 'Saved in this browser' })),
    ),
    section,
  );
  document.getElementById('root').replaceChildren(page);
  const microphone = mountMicPanel({ root: section, prefs: createPrefs(chrome.storage.local), onFix: fix });
  globalThis.narwalOptions = { microphone };
  if (typeof NARWAL_TEST !== 'undefined' && NARWAL_TEST) {
    // The e2e run shows a second panel over a browser with no microphone.
    globalThis.narwalOptions.mountWith = (fake) =>
      mountMicPanel({ root: section, prefs: createPrefs(chrome.storage.local), onFix: fix, media: { enumerateDevices: async () => fake.devices }, permission: async () => fake.permission });
  }
}

main();
