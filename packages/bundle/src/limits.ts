// Bounded import limits for schema 1.1 (docs/bundle-schema.md §11).

const MiB = 1024 * 1024;

export const LIMITS = {
  totalBytes: 1024 * MiB,
  files: 2000,
  pathChars: 200,
  manifestBytes: 1 * MiB,
  jsonBytes: 16 * MiB,
  jsonlLineBytes: 1 * MiB,
  rrwebLineBytes: 32 * MiB,
  jsonDepth: 32,
  rrwebDepth: 1000,
  documents: 10_000,
  /** Windows one recording followed (schema 1.1). */
  windows: 100,
  observations: 1_000_000,
  gaps: 100_000,
  edits: 100_000,
  revisions: 32,
  segmentsPerRevision: 100_000,
  wordsPerSegment: 2000,
  durationMs: 24 * 60 * 60 * 1000,
  /** Times may run past durationMs by this much (stop latency). */
  endToleranceMs: 1000,
  strings: {
    title: 200,
    /** manifest.purpose: why the person recorded (#16594). */
    purpose: 1000,
    elementName: 120,
    selection: 500,
    url: 2048,
    segmentText: 10_000,
    correction: 2000,
    note: 10_000,
    detail: 500,
    short: 200,
  },
} as const;

export const SUPPORTED_MAJOR = 1;
export const SUPPORTED_MINOR = 1;
export const SCHEMA_VERSION = `${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}`;
