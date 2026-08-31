import { describe, expect, it } from 'vitest';
import { createSessionTokenStore, type SessionKV } from './session-store';

function fakeSessionKV(): SessionKV {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const keyList = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (data.has(key)) result[key] = data.get(key);
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
    },
  };
}

describe('createSessionTokenStore', () => {
  it('returns undefined when nothing has been stored', async () => {
    const store = createSessionTokenStore(fakeSessionKV());
    await expect(store.get()).resolves.toBeUndefined();
  });

  it('round-trips a token through set/get', async () => {
    const store = createSessionTokenStore(fakeSessionKV());
    const token = { accessToken: 'tskey-abc', expiresAt: 12345 };
    await store.set(token);
    await expect(store.get()).resolves.toEqual(token);
  });

  it('clear() removes the stored token', async () => {
    const store = createSessionTokenStore(fakeSessionKV());
    await store.set({ accessToken: 'tskey-abc', expiresAt: 12345 });
    await store.clear();
    await expect(store.get()).resolves.toBeUndefined();
  });

  it('returns undefined instead of throwing on a malformed stored value', async () => {
    const kv = fakeSessionKV();
    await kv.set({ tailscaleAccessToken: { accessToken: 'no-expiry-field' } });
    const store = createSessionTokenStore(kv);
    await expect(store.get()).resolves.toBeUndefined();
  });

  it('two independent stores over the same backing KV see the same token', async () => {
    const kv = fakeSessionKV();
    const writer = createSessionTokenStore(kv);
    const reader = createSessionTokenStore(kv);
    await writer.set({ accessToken: 'tskey-shared', expiresAt: 999 });
    await expect(reader.get()).resolves.toEqual({ accessToken: 'tskey-shared', expiresAt: 999 });
  });
});
