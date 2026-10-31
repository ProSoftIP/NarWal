// @narwal/interactions: masked interaction evidence and explicit highlights
// for the NarWal content script (board #16543). See README.md.

export { startInteractionCapture } from './capture.ts';
export type { CaptureOptions, InteractionCapture } from './capture.ts';
export { pickExcludedRegions } from './picker.ts';
export type { RegionPicker, RegionPickerOptions } from './picker.ts';
export { MASKED_VALUE, rrwebPrivacyOptions } from './privacy.ts';
export type { RrwebPrivacyOptions } from './privacy.ts';
export { EXCLUDE_ATTR, PrivacyPolicy, UI_ATTR, describe, isRecorderUi } from './dom.ts';
export { regionContents } from './region.ts';
export type { RegionContents } from './region.ts';
export type * from './types.ts';
