// One clock for every extension context: wall-clock milliseconds from
// performance.timeOrigin + performance.now(). Chromium gives every context
// the same base, so service worker, offscreen and page times compare directly
// (measured in board #16538: residual p95 under 1 ms).
export const now = () => performance.timeOrigin + performance.now();
