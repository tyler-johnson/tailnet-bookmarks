// The storage.session seam. DESIGN.md "Auth": the access token lives in
// storage.session — memory-backed, never written to disk, never synced,
// cleared on browser restart — and specifically not a module variable,
// because Chromium tears the MV3 service worker down after roughly 30s
// idle, which would discard an in-memory token between every poll.
//
// `SessionKV` is the minimal slice of the WebExtension storage.StorageArea
// API (get/set/remove) this needs. `browser.storage.session` satisfies it
// structurally, with no adapter required, but nothing here imports the
// `browser` global into parsing or fetch code — only this one function
// touches it, and only as a lazily-evaluated default, so tests substitute
// a plain in-memory fake instead of needing a browser/WXT runtime.

import { browser } from 'wxt/browser';
import type { CachedToken, TokenStore } from './types';

export interface SessionKV {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const STORAGE_KEY = 'tailscaleAccessToken';

/**
 * The real, browser-backed TokenStore. Call with no arguments to back it
 * with `browser.storage.session`; pass a fake `SessionKV` in tests.
 */
export function createSessionTokenStore(kv?: SessionKV): TokenStore {
  const area = kv ?? (browser.storage.session as unknown as SessionKV);

  return {
    async get() {
      const stored = await area.get(STORAGE_KEY);
      const value = stored[STORAGE_KEY];
      return isCachedToken(value) ? value : undefined;
    },
    async set(token: CachedToken) {
      await area.set({ [STORAGE_KEY]: token });
    },
    async clear() {
      await area.remove(STORAGE_KEY);
    },
  };
}

function isCachedToken(value: unknown): value is CachedToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedToken).accessToken === 'string' &&
    typeof (value as CachedToken).expiresAt === 'number'
  );
}
