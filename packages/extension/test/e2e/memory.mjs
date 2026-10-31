// Where the recorder's memory is (board #16591). Linux only.
//
// The recorder is one renderer process: the offscreen document, its audio
// worklet and the Vosk worker each have a JavaScript heap there. A process
// total cannot tell them apart, so the soak also reads:
//   - the process memory by mapping name, from /proc/<pid>/smaps;
//   - each heap's size and the buffers it holds, over the DevTools protocol.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const round1 = (n) => Math.round(n * 10) / 10;

/** PSS of one process in MB, by kind of mapping. */
export async function mappings(pid) {
  const smaps = await readFile(`/proc/${pid}/smaps`, 'utf8').catch(() => '');
  return mappingsOf(smaps);
}

/** The same, from the text of a smaps file. */
export function mappingsOf(smaps) {
  const kb = { sandbox: 0, partitionAlloc: 0, v8: 0, file: 0, other: 0 };
  let kind = 'other';
  let largestSandbox = 0;
  for (const line of smaps.split('\n')) {
    const head = /^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+\s*(.*)$/.exec(line);
    if (head) {
      const name = head[1];
      // The V8 sandbox holds the JavaScript heaps and WebAssembly memory; a
      // buffer that arrived from another thread is in PartitionAlloc. Other
      // V8 mappings hold code and the browser's own collected objects.
      kind = name === '[anon:v8-sandbox]' ? 'sandbox' : name === '[anon:partition_alloc]' ? 'partitionAlloc' : name.startsWith('[anon:v8') ? 'v8' : name.startsWith('/') ? 'file' : 'other';
      continue;
    }
    const pss = /^Pss:\s+(\d+) kB/.exec(line);
    if (!pss) continue;
    kb[kind] += Number(pss[1]);
    if (kind === 'sandbox') largestSandbox = Math.max(largestSandbox, Number(pss[1]));
  }
  const out = {};
  for (const [name, value] of Object.entries(kb)) out[`${name}MB`] = round1(value / 1024);
  // In the recorder this one mapping is Vosk's WebAssembly memory.
  out.largestSandboxMB = round1(largestSandbox / 1024);
  return out;
}

/** Memory of its own that a process holds: `mappings` without the files it shares with other processes. */
export const ownMB = (m) => round1(m.sandboxMB + m.partitionAllocMB + m.v8MB + m.otherMB);

/**
 * The heaps of the offscreen document and of the workers it starts. Needs
 * `--remote-debugging-port=0` on the browser. Only the offscreen document and
 * its workers are attached: the service worker and the pages are left alone.
 */
export async function inspectRecorder(profileDir, extensionId) {
  const [port, path] = (await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools socket did not open')), { once: true });
  });
  let nextId = 0;
  const waiting = new Map();
  const sessions = new Map(); // heap name -> session ID
  const prefix = `chrome-extension://${extensionId}/`;
  const nameOf = (info) => {
    const file = info.url.slice(info.url.lastIndexOf('/') + 1).replace(/\.(html|js)$/, '');
    return info.type === 'worklet' ? 'worklet' : file;
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      waiting.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    } else if (message.method === 'Target.attachedToTarget') {
      sessions.set(nameOf(message.params.targetInfo), message.params.sessionId);
    } else if (message.method === 'Target.detachedFromTarget') {
      for (const [name, id] of sessions) if (id === message.params.sessionId) sessions.delete(name);
    }
  });
  socket.addEventListener('close', () => {
    for (const { reject } of waiting.values()) reject(new Error('DevTools socket closed'));
    waiting.clear();
  });
  const attach = async () => {
    if (sessions.has('offscreen')) return;
    const { targetInfos } = await send('Target.getTargets');
    const offscreen = targetInfos.find((t) => t.url === `${prefix}offscreen.html` && t.type !== 'worklet');
    if (!offscreen) return;
    const { sessionId } = await send('Target.attachToTarget', { targetId: offscreen.targetId, flatten: true });
    sessions.set('offscreen', sessionId);
    // Its workers and worklet attach by themselves. Not the service worker:
    // a debugger on it would change when the browser stops it.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'service_worker', exclude: true }, {}] }, sessionId);
  };
  return {
    /** `{ offscreen, worklet, 'vosk-worker' }`, each `{ usedMB, buffersMB }`; a heap that is not running is absent. */
    async heaps() {
      const out = {};
      try {
        await attach();
        for (const [name, sessionId] of [...sessions]) {
          const heap = await send('Runtime.getHeapUsage', {}, sessionId).catch(() => null);
          if (heap) out[name] = { usedMB: round1(heap.usedSize / 1048576), buffersMB: round1((heap.backingStorageSize || 0) / 1048576) };
        }
      } catch {}
      return out;
    },
    /**
     * Collects garbage in every heap of the recorder process, the service
     * worker's too. Returns the heaps it collected.
     */
    async collect() {
      const done = [];
      try {
        await attach();
        const heaps = new Map(sessions);
        // The service worker is attached for this call only: a debugger left
        // on it would change when the browser stops it.
        const { targetInfos } = await send('Target.getTargets');
        const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(prefix));
        const own = worker ? (await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId : null;
        if (own) heaps.set('service-worker', own);
        for (const [name, sessionId] of heaps) {
          if (await send('HeapProfiler.collectGarbage', {}, sessionId).then(() => true, () => false)) done.push(name);
        }
        if (own) await send('Target.detachFromTarget', { sessionId: own }).catch(() => {});
      } catch {}
      return done.sort();
    },
    close() {
      socket.close();
    },
  };
}

/** Least-squares slope of `[x, y]` points; 0 for fewer than two distinct x. */
export function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  let top = 0;
  let bottom = 0;
  for (const [x, y] of points) {
    top += (x - meanX) * (y - meanY);
    bottom += (x - meanX) ** 2;
  }
  return bottom === 0 ? 0 : top / bottom;
}

/**
 * The shape of one memory curve: `[minute, MB]` points in time order.
 *
 * A two-point slope reads a sawtooth as steady growth when it starts in a
 * trough and ends near a peak (the first reading of #16591). This fits a line
 * to all points from `fromMin` to `toMin`, and reports the range, which shows a
 * sawtooth the line hides.
 */
export function trend(points, fromMin = 0, toMin = Infinity) {
  const used = points.filter(([min, mb]) => typeof min === 'number' && typeof mb === 'number' && min >= fromMin && min <= toMin);
  const window = toMin === Infinity ? { fromMin } : { fromMin, toMin };
  if (used.length < 2) return { points: used.length, ...window };
  const values = used.map(([, mb]) => mb);
  return {
    points: used.length,
    ...window,
    firstMB: values[0],
    lastMB: values.at(-1),
    minMB: Math.min(...values),
    maxMB: Math.max(...values),
    rangeMB: round1(Math.max(...values) - Math.min(...values)),
    mbPerMin: Math.round(slope(used) * 100) / 100,
  };
}

// The soak's level-off check (#16591). What the recorder process holds is
//   - Vosk's WebAssembly memory, which fills in the first 10 minutes;
//   - what the recording needs, which does not grow;
//   - garbage that the browser has not collected yet, in four heaps (offscreen
//     document, audio worklet, Vosk worker, service worker). The largest part
//     is the audio sent to the Vosk worker: it stays until that worker's next
//     collection, about every 7 minutes, up to 27 MB.
// A curve of the process alone cannot tell a leak from late garbage, so the
// soak collects the garbage at `liveAtMin` and at the end, and compares what
// is left. `freedMB` is how much garbage a collection may find.
export const LIMITS = { liveAtMin: [12, 21], levelMinutes: 30, liveRiseMB: 5, freedMB: 45 };

/** The four heaps of the recorder process, as `collect()` names them. */
export const HEAPS = ['offscreen', 'service-worker', 'vosk-worker', 'worklet'];

/**
 * Reads the soak's `{ atMin, collected, beforeMB, liveMB }` readings: memory
 * before and after a garbage collection in every heap.
 */
export function liveMemory(readings) {
  const whole = readings.filter((r) => HEAPS.every((name) => r.collected.includes(name)));
  const live = whole.map((r) => r.liveMB);
  const freed = whole.map((r) => round1(r.beforeMB - r.liveMB));
  return {
    readings: readings.length,
    collectedEveryHeap: whole.length,
    atMin: whole.map((r) => r.atMin),
    liveMB: live,
    riseMB: live.length ? round1(Math.max(...live) - live[0]) : null,
    freedMB: freed,
    mostFreedMB: freed.length ? Math.max(...freed) : null,
  };
}

/** No leak: what is left after a collection is the same at every reading. */
export const liveLevelsOff = (m) => m.readings >= 3 && m.collectedEveryHeap === m.readings && m.riseMB <= LIMITS.liveRiseMB;

/** Garbage does not pile up: no collection finds more than the limit. */
export const garbageIsBounded = (m) => m.readings >= 3 && m.collectedEveryHeap === m.readings && m.mostFreedMB <= LIMITS.freedMB;
