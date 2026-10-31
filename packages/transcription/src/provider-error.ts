// Thrown provider errors. Adapters and credential brokers throw this so callers
// get the contract's ProviderError (kind, retryable) instead of a bare Error.

import type { ProviderError } from './contract.ts';

export class ProviderErrorException extends Error {
  readonly error: ProviderError;

  constructor(error: ProviderError) {
    super(`${error.provider} ${error.kind} (${error.code}): ${error.message}`);
    this.name = 'ProviderErrorException';
    this.error = error;
  }
}

/**
 * Errors a retry with the same key cannot fix; the user must act. A retryable
 * auth error (a token the socket refused) is not one: the next connection
 * mints a fresh credential, and the mint names a bad key as non-retryable.
 */
export function needsUserAction(error: ProviderError): boolean {
  return !error.retryable && (error.kind === 'auth' || error.kind === 'quota' || error.kind === 'input');
}

/**
 * Replaces every occurrence of each secret with `[redacted]`. Provider error
 * text can echo request details, so every message that leaves a credential
 * boundary passes through this.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join('[redacted]');
  }
  return result;
}
