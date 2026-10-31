// Demo of the start view with a fake recorder. ?s=<scenario> (scenarios.js).
import { createFakePort, createPrefs, memoryStorageArea, mountStartView, PREFS_KEY } from '../src/index.js';
import { START_SCENARIOS } from './scenarios.js';

const name = new URLSearchParams(location.search).get('s') || 'first-use';
const scenario = START_SCENARIOS[name] || START_SCENARIOS['first-use'];
const area = memoryStorageArea(scenario.prefs ? { [PREFS_KEY]: scenario.prefs } : {});
const port = createFakePort(scenario.status, scenario.behaviour);

// The fake only flips the model to "downloading"; walk it to "ready".
const download = port.downloadModel.bind(port);
port.downloadModel = async () => {
  await download();
  const total = port.status().model.bytesTotal || 43_500_000;
  let done = 0;
  const step = setInterval(() => {
    done = Math.min(total, done + total / 8);
    port.set({ model: done >= total ? { state: 'ready', bytesTotal: total } : { state: 'downloading', bytesDone: done, bytesTotal: total } });
    if (done >= total) clearInterval(step);
  }, 150);
};

const view = mountStartView({ root: document.getElementById('root'), port, prefs: createPrefs(area) });
window.__narwal = { port, area, view };
