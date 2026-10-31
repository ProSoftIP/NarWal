// Demo of the strip over a page, with a fake recorder. ?s=<scenario>
// (scenarios.js). ?shadow=open lets the e2e run look inside the strip;
// ?mount=later leaves mounting to the caller (window.__narwal.mount()).
import { createFakePort, mountStrip } from '../src/index.js';
import { STRIP_SCENARIOS } from './scenarios.js';

const rows = document.getElementById('rows');
for (let i = 1; i <= 40; i += 1) {
  const tr = document.createElement('tr');
  for (const text of [`Employee ${i}`, i % 3 ? 'Technician' : 'Supervisor', String(30 + (i % 12)), `$${(900 + i * 37).toLocaleString('en-US')}`]) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  rows.append(tr);
}

const params = new URLSearchParams(location.search);
const scenario = STRIP_SCENARIOS[params.get('s') || 'recording'] || STRIP_SCENARIOS.recording;
const port = createFakePort(scenario.status);
const shadowMode = params.get('shadow') === 'open' ? 'open' : 'closed';

const demo = { port, strip: null, pageEvents: [] };
demo.mount = () => {
  demo.strip = mountStrip({ document, port, shadowMode });
  for (const event of scenario.events || []) port.emit(event);
  return demo.strip;
};
// What page-level handlers saw: the strip's keys and clicks must not show up.
for (const type of ['keydown', 'click', 'mousedown']) {
  document.addEventListener(type, (event) => demo.pageEvents.push({ type, key: event.key || null, target: event.target.tagName }));
}
window.__narwal = demo;
if (params.get('mount') !== 'later') demo.mount();
