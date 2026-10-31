// What the user sees about a cloud provider before and during a recording, and
// what a transcript records about the service that actually produced it.

import type { ProviderId } from './contract.ts';

/**
 * Shown on the provider picker and the recording strip. NarWal has no server,
 * accounts or billing: the provider bills the user's own account directly.
 */
export interface ProviderIdentity {
  provider: ProviderId;
  displayName: string;
  billing: 'direct-provider';
  /** One sentence: who bills, and on what basis. */
  billingNotice: string;
  /** Shown when the user selects the provider; selecting it is the consent. */
  consentNotice: string;
  pricingUrl: string;
  keysUrl: string;
}

/**
 * The service that produced a transcript, as observed on the wire. Recorded on
 * the transcript so a reader knows the API, model and version that ran. Never
 * holds a key or token.
 */
export interface ProviderServiceRecord {
  provider: ProviderId;
  /** Endpoint without query string, e.g. wss://api.deepgram.com/v1/listen. */
  api: string;
  requestedModel: string;
  /** Model name the provider reported, when it reported one. */
  reportedModel?: string;
  /** Model version the provider reported, when it reported one. */
  modelVersion?: string;
  /** Provider request IDs, one per connection, for support tickets. */
  requestIds: string[];
  auth: 'temporary-token' | 'api-key';
}
