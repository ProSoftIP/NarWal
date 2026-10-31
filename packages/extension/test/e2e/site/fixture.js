// Main-world helpers the e2e harness drives.
window.narwalFixture = {
  mark(label) {
    const p = document.createElement('p');
    p.dataset.marker = label;
    p.textContent = `marker:${label}`;
    (document.body || document.documentElement).appendChild(p);
    return performance.timeOrigin + performance.now();
  },
};
