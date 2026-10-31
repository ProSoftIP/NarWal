// NarWal capture probe — manual-mode report page (board #16538).
// Grants the microphone to the extension origin (an offscreen document cannot
// show a permission prompt) and downloads the last recording for analysis.
import { summarise } from '../../harness/analyze.mjs';

const $ = (id) => document.getElementById(id);
let last = null;

async function showPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    $('perm').textContent = `Microphone permission for this extension: ${status.state}`;
    status.onchange = showPermission;
  } catch (err) {
    $('perm').textContent = `Microphone permission state unavailable: ${err.message}`;
  }
}

$('grant').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    $('perm').textContent = `Microphone request failed: ${err.name} ${err.message}`;
    return;
  }
  showPermission();
});

$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(last)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `narwal-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
});

async function load() {
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'dump' });
  } catch (err) {
    reply = null;
  }
  if (!reply || !reply.session) return;
  last = { probeVersion: 1, userAgent: navigator.userAgent, platform: navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform, session: reply.session };
  $('download').disabled = false;
  $('summary').textContent = JSON.stringify(summarise(reply.session), null, 2);
}

showPermission();
load();
