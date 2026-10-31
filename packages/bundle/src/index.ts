// NarWal recording bundle, schema 1.1 (docs/bundle-schema.md): validator and agent exports.
// Runs in the browser and Node; the directory source lives in ./node-dir.ts.

export { bundleValidator, validateBundle } from './validate.ts';
export { DERIVED_PATHS, deriveAgentFiles } from './derived.ts';
export {
  ALLOWED_EXTENSIONS,
  MAX_PATH_CHARS,
  extensionOf,
  holdsCredentialText,
  isCredentialKey,
  isCredentialValue,
  unsafePathReason,
} from './rules.ts';
export { README_PATHS, buildAgentView, renderMarkdown, renderReadme, stableJson, formatTime, quote, token } from './agent-view.ts';
export type { AgentView, AgentEntry, EvidenceItem } from './agent-view.ts';
export { LIMITS, SCHEMA_VERSION } from './limits.ts';
export { memorySource } from './memory-source.ts';
export type * from './types.ts';
