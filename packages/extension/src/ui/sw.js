// Messages from extension pages to the service worker.
export const toWorker = (cmd, extra = {}) => chrome.runtime.sendMessage({ to: 'sw', cmd, ...extra });

export async function microphoneState() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

export function clockTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
