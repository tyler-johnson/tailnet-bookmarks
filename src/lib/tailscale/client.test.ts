import { describe, expect, it, vi } from 'vitest';
import {
  fetchAccessToken,
  fetchDevices,
  fetchServices,
  fetchTailnetData,
  getAccessToken,
  TailscaleAuthError,
} from './client';
import { devicesResponseFixture, tokenResponseFixture, vipServicesResponseFixture } from './fixtures';
import type { CachedToken, TokenStore } from './types';

const CREDENTIALS = { clientId: 'client-1', clientSecret: 'secret-1' };

/** Matches client.ts's own `FetchFn = typeof fetch`, spelled out locally
 * so test mocks type-check without fighting the ambient `fetch` overload
 * set (DOM + @types/node). */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function memoryTokenStore(initial?: CachedToken): TokenStore {
  let value = initial;
  return {
    async get() {
      return value;
    },
    async set(token) {
      value = token;
    },
    async clear() {
      value = undefined;
    },
  };
}

describe('fetchAccessToken', () => {
  it('POSTs the client_credentials grant and returns the parsed token', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(tokenResponseFixture));
    const now = () => 1_000_000;

    const token = await fetchAccessToken(CREDENTIALS, fetchImpl, now);

    expect(token).toEqual({ accessToken: 'fixture-access-token', expiresAt: 1_000_000 + 3600 * 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    const [url, init] = call;
    expect(url).toBe('https://api.tailscale.com/api/v2/oauth/token');
    expect(init?.method).toBe('POST');
    const body = init?.body as URLSearchParams;
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    expect(body.get('grant_type')).toBe('client_credentials');
  });

  it('throws TailscaleAuthError on a non-2xx response', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ error: 'nope' }, { status: 401 }));
    await expect(fetchAccessToken(CREDENTIALS, fetchImpl)).rejects.toThrow(TailscaleAuthError);
  });

  it('throws TailscaleAuthError when the response has no access_token', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ token_type: 'Bearer' }));
    await expect(fetchAccessToken(CREDENTIALS, fetchImpl)).rejects.toThrow(TailscaleAuthError);
  });

  it('throws TailscaleAuthError on a network failure', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error('DNS resolution failed');
    });
    await expect(fetchAccessToken(CREDENTIALS, fetchImpl)).rejects.toThrow(TailscaleAuthError);
  });
});

describe('getAccessToken', () => {
  it('returns the cached token without fetching when it is not near expiry', async () => {
    const store = memoryTokenStore({ accessToken: 'cached-token', expiresAt: 1_000_000 });
    const fetchImpl = vi.fn<FetchImpl>();

    const token = await getAccessToken(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(token).toBe('cached-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches a new token when the cache is empty', async () => {
    const store = memoryTokenStore(undefined);
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(tokenResponseFixture));

    const token = await getAccessToken(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(token).toBe('fixture-access-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(store.get()).resolves.toMatchObject({ accessToken: 'fixture-access-token' });
  });

  it('refetches when the cached token is within the expiry skew window', async () => {
    const store = memoryTokenStore({ accessToken: 'stale-token', expiresAt: 1_000_030_000 }); // 30s out
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(tokenResponseFixture));

    const token = await getAccessToken(CREDENTIALS, store, { fetchImpl, now: () => 1_000_000_000 });

    expect(token).toBe('fixture-access-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchDevices — present vs. unknown', () => {
  it('returns ok with parsed items on success', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(devicesResponseFixture));
    const slice = await fetchDevices('token', fetchImpl);
    expect(slice.status).toBe('ok');
    if (slice.status === 'ok') expect(slice.items).toHaveLength(2);

    const call = fetchImpl.mock.calls[0]!;
    const [url, init] = call;
    expect(url).toBe('https://api.tailscale.com/api/v2/tailnet/-/devices');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('is unknown — never an empty list — on a 500', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ error: 'internal' }, { status: 500 }));
    const slice = await fetchDevices('token', fetchImpl);
    expect(slice).toEqual({ status: 'unknown', reason: 'HTTP 500' });
  });

  it('is unknown on a network error', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error('offline');
    });
    const slice = await fetchDevices('token', fetchImpl);
    expect(slice.status).toBe('unknown');
  });

  it('is unknown on a body that is not valid JSON', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => new Response('not json', { status: 200 }));
    const slice = await fetchDevices('token', fetchImpl);
    expect(slice.status).toBe('unknown');
  });

  it('is unknown when the confirmed devices envelope is absent even on a 200', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ somethingElse: true }));
    const slice = await fetchDevices('token', fetchImpl);
    expect(slice.status).toBe('unknown');
  });
});

describe('fetchServices — present vs. unknown', () => {
  it('returns ok with parsed items on success', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse(vipServicesResponseFixture));
    const slice = await fetchServices('token', fetchImpl);
    expect(slice.status).toBe('ok');
    if (slice.status === 'ok') expect(slice.items).toHaveLength(2);
  });

  it('is unknown — never an empty list — on a 500 (the case DESIGN.md calls out by name)', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ error: 'internal' }, { status: 500 }));
    const slice = await fetchServices('token', fetchImpl);
    expect(slice).toEqual({ status: 'unknown', reason: 'HTTP 500' });
  });

  it('is unknown on a network error', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error('offline');
    });
    const slice = await fetchServices('token', fetchImpl);
    expect(slice.status).toBe('unknown');
  });

  it('is unknown — not ok-with-zero — when a 200 body has no recognized envelope', async () => {
    // The vip-services shape is UNVERIFIED (DESIGN.md "Known limits"). A
    // payload key we failed to guess produces the same "zero rows" shape
    // a 500 does, so it must not silently read as an empty desired set —
    // that is exactly what the per-source-slices rule exists to prevent,
    // just arriving through the parser instead of a failed request.
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ somethingCompletelyDifferent: [] }));
    const slice = await fetchServices('token', fetchImpl);
    expect(slice.status).toBe('unknown');
  });

  it('is ok with zero items when a recognized envelope genuinely holds none — a tailnet with no services must reconcile to zero', async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => jsonResponse({ vipServices: [] }));
    const slice = await fetchServices('token', fetchImpl);
    expect(slice).toEqual({ status: 'ok', items: [] });
  });
});

describe('fetchTailnetData', () => {
  function routingFetch(handlers: Record<string, () => Response>) {
    return vi.fn<FetchImpl>(async (input) => {
      const url = String(input);
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (url.startsWith(prefix)) return handler();
      }
      throw new Error(`unexpected URL: ${url}`);
    });
  }

  it('fetches a token once and reuses it for both reads', async () => {
    const fetchImpl = routingFetch({
      'https://api.tailscale.com/api/v2/oauth/token': () => jsonResponse(tokenResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/devices': () => jsonResponse(devicesResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/vip-services': () => jsonResponse(vipServicesResponseFixture),
    });
    const store = memoryTokenStore(undefined);

    const data = await fetchTailnetData(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(data.devices.status).toBe('ok');
    expect(data.services.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3); // one attempt each: token, devices, services

    const devicesCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes('/devices'))!;
    const servicesCall = fetchImpl.mock.calls.find((call) => String(call[0]).includes('/vip-services'))!;
    const devicesAuth = devicesCall[1]?.headers as Record<string, string>;
    const servicesAuth = servicesCall[1]?.headers as Record<string, string>;
    expect(devicesAuth.Authorization).toBe('Bearer fixture-access-token');
    expect(servicesAuth.Authorization).toBe('Bearer fixture-access-token');
  });

  it('both slices are unknown, and neither read is attempted, when the token request fails', async () => {
    const fetchImpl = routingFetch({
      'https://api.tailscale.com/api/v2/oauth/token': () => jsonResponse({ error: 'invalid_client' }, { status: 401 }),
    });
    const store = memoryTokenStore(undefined);

    const data = await fetchTailnetData(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(data.devices.status).toBe('unknown');
    expect(data.services.status).toBe('unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the token attempt — the reads never happened
  });

  it('per-source slices: a failing vip-services read does not affect the devices slice', async () => {
    const fetchImpl = routingFetch({
      'https://api.tailscale.com/api/v2/oauth/token': () => jsonResponse(tokenResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/devices': () => jsonResponse(devicesResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/vip-services': () => jsonResponse({ error: 'internal' }, { status: 500 }),
    });
    const store = memoryTokenStore(undefined);

    const data = await fetchTailnetData(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(data.devices).toEqual({ status: 'ok', items: expect.any(Array) });
    expect(data.services).toEqual({ status: 'unknown', reason: 'HTTP 500' });
    if (data.devices.status === 'ok') expect(data.devices.items).toHaveLength(2);
  });

  it('per-source slices: a failing devices read does not affect the services slice', async () => {
    const fetchImpl = routingFetch({
      'https://api.tailscale.com/api/v2/oauth/token': () => jsonResponse(tokenResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/devices': () => jsonResponse({ error: 'internal' }, { status: 500 }),
      'https://api.tailscale.com/api/v2/tailnet/-/vip-services': () => jsonResponse(vipServicesResponseFixture),
    });
    const store = memoryTokenStore(undefined);

    const data = await fetchTailnetData(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(data.devices).toEqual({ status: 'unknown', reason: 'HTTP 500' });
    expect(data.services.status).toBe('ok');
  });

  it('makes exactly one attempt per endpoint even when everything fails — no retries here', async () => {
    const fetchImpl = routingFetch({
      'https://api.tailscale.com/api/v2/oauth/token': () => jsonResponse(tokenResponseFixture),
      'https://api.tailscale.com/api/v2/tailnet/-/devices': () => jsonResponse({}, { status: 500 }),
      'https://api.tailscale.com/api/v2/tailnet/-/vip-services': () => jsonResponse({}, { status: 500 }),
    });
    const store = memoryTokenStore(undefined);

    await fetchTailnetData(CREDENTIALS, store, { fetchImpl, now: () => 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
