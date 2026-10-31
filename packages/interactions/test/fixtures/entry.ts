// Test harness bundled into the fixture pages: rrweb plus this package, wired
// the way the extension's content script wires them (board #16542).
import { record } from 'rrweb';
import { pickExcludedRegions, rrwebPrivacyOptions, startInteractionCapture } from '../../src/index.ts';
import type { CaptureOptions, InteractionCapture, Observation } from '../../src/index.ts';

interface Harness {
  events: unknown[];
  observations: Observation[];
  capture: InteractionCapture | null;
  picked: string[] | null;
  start(exclusions?: string[], options?: Partial<CaptureOptions>): void;
  stop(): void;
  pick(): void;
  privacyOptions: typeof rrwebPrivacyOptions;
}

let stopRecord: (() => void) | undefined;

const harness: Harness = {
  events: [],
  observations: [],
  capture: null,
  picked: null,
  start(exclusions = [], options = {}) {
    stopRecord = record({ emit: (event) => harness.events.push(event), ...rrwebPrivacyOptions(exclusions) });
    harness.capture = startInteractionCapture({
      doc: document.documentElement.dataset.doc ?? 'd0',
      exclusions,
      emit: (o) => harness.observations.push(o),
      nodeIdOf: (node) => {
        const id = record.mirror.getId(node);
        return id > 0 ? id : null;
      },
      ...options,
    });
  },
  stop() {
    harness.capture?.stop();
    stopRecord?.();
  },
  privacyOptions: rrwebPrivacyOptions,
  pick() {
    void pickExcludedRegions().done.then((selectors) => {
      harness.picked = selectors;
    });
  },
};

(window as unknown as { narwal: Harness }).narwal = harness;
