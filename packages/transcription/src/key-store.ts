// Personal provider API keys, owned by the extension (no NarWal server).
//
// Keys live in chrome.storage.local, never storage.sync (sync copies data to
// every browser the user signs in to). storage.local is readable by content
// scripts by default, so the store refuses to save a key until the area is
// restricted to trusted extension contexts. Only the service worker reads a key;
// other contexts receive the narrowest credential the provider supports.
// https://developer.chrome.com/docs/extensions/reference/api/storage

import type { ProviderId } from './contract.ts';

/** The subset of chrome.storage.StorageArea the store uses. */
export interface StorageAreaLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

export class KeyStorageNotRestricted extends Error {
  constructor() {
    super('Key storage is not restricted to trusted extension contexts; refusing to store a provider key');
    this.name = 'KeyStorageNotRestricted';
  }
}

// Shared with the settings UI (#16551): one entry per provider.
const STORAGE_PREFIX = 'narwal.key.';

export class ProviderKeyStore {
  private readonly area: StorageAreaLike;
  private restricted = false;

  constructor(area: StorageAreaLike) {
    this.area = area;
  }

  /**
   * Restricts the storage area to trusted contexts. Call at service-worker
   * startup. Returns false when the browser has no setAccessLevel for this
   * area; the store then refuses to save keys.
   */
  async restrictToTrustedContexts(): Promise<boolean> {
    if (typeof this.area.setAccessLevel !== 'function') return false;
    try {
      await this.area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      this.restricted = true;
    } catch {
      this.restricted = false;
    }
    return this.restricted;
  }

  async getKey(provider: ProviderId): Promise<string | null> {
    const name = STORAGE_PREFIX + provider;
    const items = await this.area.get([name]);
    const value = items[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /** For contexts that show key presence: returns no key material. */
  async hasKey(provider: ProviderId): Promise<boolean> {
    return (await this.getKey(provider)) !== null;
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    if (!this.restricted) throw new KeyStorageNotRestricted();
    const trimmed = key.trim();
    if (trimmed.length === 0 || /\s/.test(trimmed)) {
      throw new TypeError('A provider key is one token with no spaces');
    }
    await this.area.set({ [STORAGE_PREFIX + provider]: trimmed });
  }

  async removeKey(provider: ProviderId): Promise<void> {
    await this.area.remove([STORAGE_PREFIX + provider]);
  }
}

/** For settings display: the last four characters only. */
export function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}
