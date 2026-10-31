// Main-world helpers the harness drives (board #16538 fixtures).
window.narwalFixture = {
  mark(label) {
    const p = document.createElement('p');
    p.dataset.marker = label;
    p.textContent = `marker:${label}`;
    (document.body || document.documentElement).appendChild(p);
    return performance.timeOrigin + performance.now();
  },
  ticker: null,
  startTicker(ms = 200) {
    let n = 0;
    const span = document.getElementById('tick') || document.body.appendChild(Object.assign(document.createElement('span'), { id: 'tick' }));
    this.ticker = setInterval(() => {
      n += 1;
      span.textContent = `tick-${n}`;
    }, ms);
  },
  stopTicker() {
    clearInterval(this.ticker);
  },
};
// Counts page-visible postMessage traffic that looks like rrweb's cross-origin
// iframe relay, to show what the embedding page's own scripts can read.
window.__relayMessages = 0;
window.addEventListener('message', (e) => {
  if (e.data && typeof e.data === 'object' && e.data.type === 'rrweb') window.__relayMessages += 1;
});
