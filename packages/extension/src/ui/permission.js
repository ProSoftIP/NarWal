// Visible page that asks for the microphone once (the popup and the
// offscreen recorder cannot show the prompt), then returns to the tab the
// user came from. Recording starts from the start view.
import { guardThisPage } from './page-guard.js';

// A new build in the folder waits while this page is in use (board #17009).
guardThisPage();

const tabId = Number(new URLSearchParams(location.search).get('tab'));
const problem = document.getElementById('problem');

document.getElementById('allow').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    problem.textContent =
      err && err.name === 'NotFoundError'
        ? 'No microphone was found. Connect one, then try again.'
        : `The microphone was not allowed (${err && err.name}). To change that, open the site settings for NarWal and allow the microphone.`;
    problem.hidden = false;
    return;
  }
  if (Number.isInteger(tabId)) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  window.close();
};
