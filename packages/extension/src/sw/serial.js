// Runs async jobs one at a time, in call order. A job that throws does not
// stop the jobs queued after it (board #16568).
export function createSerial() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(() => job());
    tail = run.catch(() => {});
    return run;
  };
}
