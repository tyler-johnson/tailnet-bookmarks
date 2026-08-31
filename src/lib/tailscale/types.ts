// Shared types for the `tailscale` component (DESIGN.md "Components":
// "Token lifecycle and the two API reads. Returns slices that are
// explicitly present or unknown.").

/**
 * A tailnet device, as returned by `GET /api/v2/tailnet/-/devices`.
 *
 * CONFIRMED against Tailscale's public API reference
 * (https://tailscale.com/api#tag/devices/GET/tailnet/{tailnet}/devices).
 */
export interface TailscaleDevice {
  id: string;
  /** Fully-qualified MagicDNS name, e.g. "host.tailnet-name.ts.net". */
  name: string;
  /** Short hostname, e.g. "host". */
  hostname: string;
  addresses: string[];
  os: string;
  authorized: boolean;
  /** ISO 8601 timestamp, or "" if the field was missing. */
  lastSeen: string;
}

/** One port a Service advertises. */
export interface ServicePort {
  port: number;
  protocol: 'tcp' | 'udp';
}

/**
 * A declared tailnet Service, as returned by
 * `GET /api/v2/tailnet/-/vip-services`.
 *
 * UNVERIFIED — DESIGN.md ("Known limits" / "Service response shape
 * unverified") books this endpoint's response shape as unconfirmed
 * against a live tailnet. The fields below are the best-effort reading
 * of Tailscale's VIP Services documentation as of this writing; see
 * fixtures.ts for exactly which parts are inferred, and parse.ts for how
 * the parser tolerates the plausible alternates instead of throwing.
 */
export interface TailscaleService {
  name: string;
  addrs: string[];
  ports: ServicePort[];
  /** Becomes the bookmark label per DESIGN.md "Data model". */
  comment?: string;
}

/**
 * Present-with-rows or unknown — never an empty array standing in for a
 * failed fetch. DESIGN.md "Sync and convergence" / "Per-source slices":
 * a slice whose fetch failed is left entirely alone, not reconciled to
 * empty, or a 500 from an endpoint deletes every bookmark from that
 * source on the next poll.
 */
export type Slice<T> = { status: 'ok'; items: T[] } | { status: 'unknown'; reason: string };

/** An OAuth client using the client_credentials grant (DESIGN.md "Auth"). */
export interface TailscaleCredentials {
  clientId: string;
  clientSecret: string;
}

/** An access token cached alongside its absolute expiry. */
export interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Where the access token lives between calls. DESIGN.md "Auth": the
 * token lives in `storage.session` — memory-backed, never on disk, never
 * synced, cleared on browser restart — and specifically not a module
 * variable, because the MV3 service worker is torn down between polls.
 * `session-store.ts` is the real, browser-backed implementation; tests
 * substitute an in-memory one.
 */
export interface TokenStore {
  get(): Promise<CachedToken | undefined>;
  set(token: CachedToken): Promise<void>;
  clear(): Promise<void>;
}

export interface TailnetData {
  devices: Slice<TailscaleDevice>;
  services: Slice<TailscaleService>;
}
