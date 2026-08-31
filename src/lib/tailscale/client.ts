// Token lifecycle and the two API reads (DESIGN.md "Components" /
// "tailscale", and the "Approach" flowchart). No browser API beyond
// `fetch`, which is injectable, so this runs the same under vitest as it
// does in the MV3 worker.
//
// One attempt per run: nothing in this file retries. DESIGN.md's
// flowchart puts the retry at the alarm, not in here.

import { errorMessage, isRecord } from './internal';
import { parseDevicesResponse, parseVipServicesResponse } from './parse';
import type { CachedToken, Slice, TailnetData, TailscaleCredentials, TailscaleDevice, TailscaleService, TokenStore } from './types';

const TOKEN_URL = 'https://api.tailscale.com/api/v2/oauth/token';
const DEVICES_URL = 'https://api.tailscale.com/api/v2/tailnet/-/devices';
const VIP_SERVICES_URL = 'https://api.tailscale.com/api/v2/tailnet/-/vip-services';

/** A token request failed, or the token response didn't look like one. */
export class TailscaleAuthError extends Error {}

type FetchFn = typeof fetch;

export interface FetchTailnetDataOptions {
  fetchImpl?: FetchFn;
  /** Injectable clock for expiry math; defaults to Date.now. */
  now?: () => number;
}

/**
 * POSTs the client_credentials grant. CONFIRMED shape (Tailscale OAuth
 * clients docs): `{ access_token, token_type, expires_in }`. Throws
 * TailscaleAuthError on any failure — the caller decides what that means
 * for the resulting slices.
 */
export async function fetchAccessToken(
  credentials: TailscaleCredentials,
  fetchImpl: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<CachedToken> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'client_credentials',
  });

  const result = await requestJson(
    TOKEN_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    fetchImpl,
  );
  if (!result.ok) {
    throw new TailscaleAuthError(`token request failed: ${result.reason}`);
  }
  if (!isRecord(result.json) || typeof result.json.access_token !== 'string') {
    throw new TailscaleAuthError('token response missing access_token');
  }

  const expiresIn = typeof result.json.expires_in === 'number' ? result.json.expires_in : 3600;
  return { accessToken: result.json.access_token, expiresAt: now() + expiresIn * 1000 };
}

/** Refresh margin: treat a token as expired this far before its real expiry. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Returns a usable access token, refreshing on demand (DESIGN.md "Auth":
 * "Refresh on demand"). Reads the cache first; fetches and stores a new
 * token only when nothing cached is still good for at least
 * EXPIRY_SKEW_MS. Throws TailscaleAuthError if a fetch was needed and it
 * failed.
 */
export async function getAccessToken(
  credentials: TailscaleCredentials,
  store: TokenStore,
  options: FetchTailnetDataOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const cached = await store.get();
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > now()) {
    return cached.accessToken;
  }

  const fetched = await fetchAccessToken(credentials, options.fetchImpl ?? fetch, now);
  await store.set(fetched);
  return fetched.accessToken;
}

/**
 * GET /api/v2/tailnet/-/devices. Never throws: a failure of any kind
 * (network, HTTP status, JSON, or the confirmed envelope not being
 * present) becomes `{ status: 'unknown' }`, never an empty item list.
 */
export async function fetchDevices(accessToken: string, fetchImpl: FetchFn = fetch): Promise<Slice<TailscaleDevice>> {
  const result = await requestJson(DEVICES_URL, { headers: authHeader(accessToken) }, fetchImpl);
  if (!result.ok) return { status: 'unknown', reason: result.reason };

  try {
    return { status: 'ok', items: parseDevicesResponse(result.json) };
  } catch (err) {
    return { status: 'unknown', reason: `unparseable devices response: ${errorMessage(err)}` };
  }
}

/**
 * GET /api/v2/tailnet/-/vip-services. Never throws. A request failure
 * (network, HTTP status, invalid JSON) becomes `{ status: 'unknown' }`.
 * A 200 whose body doesn't match any envelope parseVipServicesResponse
 * recognizes is *also* `{ status: 'unknown' }`: the vip-services shape
 * is UNVERIFIED (DESIGN.md "Known limits"), and guessing the payload key
 * wrong produces the same "zero rows" shape a 500 does, which the
 * per-source-slices rule exists specifically to keep out of the desired
 * set. A recognized envelope with zero rows — a tailnet that genuinely
 * declares no services — is `{ status: 'ok', items: [] }`, distinct from
 * that. See parse.ts's VipServicesParseResult.
 */
export async function fetchServices(accessToken: string, fetchImpl: FetchFn = fetch): Promise<Slice<TailscaleService>> {
  const result = await requestJson(VIP_SERVICES_URL, { headers: authHeader(accessToken) }, fetchImpl);
  if (!result.ok) return { status: 'unknown', reason: result.reason };

  const parsed = parseVipServicesResponse(result.json);
  if (!parsed.recognized) {
    return { status: 'unknown', reason: 'vip-services response envelope not recognized' };
  }
  return { status: 'ok', items: parsed.items };
}

/**
 * The full read: a token, then both endpoints. If the token can't be
 * obtained, both slices come back unknown without attempting either GET
 * (DESIGN.md flowchart: token failure means both reads fail). Otherwise
 * the two reads run independently — one failing does not affect the
 * other's result (DESIGN.md "Per-source slices").
 */
export async function fetchTailnetData(
  credentials: TailscaleCredentials,
  tokenStore: TokenStore,
  options: FetchTailnetDataOptions = {},
): Promise<TailnetData> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(credentials, tokenStore, { fetchImpl, now: options.now });
  } catch (err) {
    const reason = `token unavailable: ${errorMessage(err)}`;
    return {
      devices: { status: 'unknown', reason },
      services: { status: 'unknown', reason },
    };
  }

  const [devices, services] = await Promise.all([
    fetchDevices(accessToken, fetchImpl),
    fetchServices(accessToken, fetchImpl),
  ]);
  return { devices, services };
}

function authHeader(accessToken: string): HeadersInit {
  return { Authorization: `Bearer ${accessToken}` };
}

type RequestResult = { ok: true; json: unknown } | { ok: false; reason: string };

async function requestJson(url: string, init: RequestInit, fetchImpl: FetchFn): Promise<RequestResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    return { ok: false, reason: `network error: ${errorMessage(err)}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `HTTP ${response.status}` };
  }
  try {
    return { ok: true, json: await response.json() };
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${errorMessage(err)}` };
  }
}
