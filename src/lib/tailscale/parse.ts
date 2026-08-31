// Pure parsing of already-decoded JSON bodies. No browser API, no I/O, no
// fetch — the fetching (client.ts) decides ok-vs-unknown from the HTTP
// outcome; these functions only ever turn a JSON value into rows.

import { firstString, firstStringArray, isRecord } from './internal';
import type { ServicePort, TailscaleDevice, TailscaleService } from './types';

export class TailscaleParseError extends Error {}

/**
 * Parses `GET /api/v2/tailnet/-/devices`. CONFIRMED shape (see types.ts):
 * a `{ devices: [...] }` envelope. Throws TailscaleParseError if that
 * envelope itself isn't present — the caller (client.ts) turns that into
 * an unknown slice, same as a network failure, because getting a 200
 * with a completely different envelope means nothing here can be
 * trusted. Individual malformed entries (missing id/name) are skipped
 * rather than failing the whole read.
 */
export function parseDevicesResponse(json: unknown): TailscaleDevice[] {
  if (!isRecord(json) || !Array.isArray(json.devices)) {
    throw new TailscaleParseError('devices response has no "devices" array');
  }

  const devices: TailscaleDevice[] = [];
  for (const raw of json.devices) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const name = typeof raw.name === 'string' ? raw.name : undefined;
    if (!id || !name) continue; // can't build a bookmark without an id and a MagicDNS name

    devices.push({
      id,
      name,
      hostname: typeof raw.hostname === 'string' ? raw.hostname : (name.split('.')[0] ?? name),
      addresses: Array.isArray(raw.addresses) ? raw.addresses.filter((a): a is string => typeof a === 'string') : [],
      os: typeof raw.os === 'string' ? raw.os : '',
      authorized: typeof raw.authorized === 'boolean' ? raw.authorized : true,
      lastSeen: typeof raw.lastSeen === 'string' ? raw.lastSeen : '',
    });
  }
  return devices;
}

/** Discriminates "we found a list, even an empty one" from "none of our
 * guesses at the envelope matched" — never throws, never collapses the
 * two to a bare `[]`. See parseVipServicesResponse. */
export type VipServicesParseResult = { recognized: true; items: TailscaleService[] } | { recognized: false };

/**
 * Parses `GET /api/v2/tailnet/-/vip-services`. UNVERIFIED shape (see
 * types.ts and DESIGN.md "Known limits"). This never throws, but it does
 * distinguish two different 200s that both look like "nothing to parse":
 *
 * - A recognized envelope (a bare array, or one of the plausible keys
 *   below) whose list is empty means the tailnet genuinely declares no
 *   services — `{ recognized: true, items: [] }`. That must reconcile to
 *   zero, not freeze the slice.
 * - No recognized envelope at all means our guess at the unverified
 *   shape was wrong, not that the tailnet has no services —
 *   `{ recognized: false }`. client.ts turns this into an unknown slice,
 *   same as a network failure: DESIGN.md's per-source-slices rule exists
 *   precisely so a 500 from vip-services can't delete every service
 *   bookmark, and a payload key we failed to guess produces the exact
 *   same "zero rows, one poll" shape a 500 does — it must not be allowed
 *   to arrive at the planner as ok-with-zero.
 *
 * Individual malformed entries inside a recognized envelope are still
 * skipped rather than failing the whole read.
 */
export function parseVipServicesResponse(json: unknown): VipServicesParseResult {
  const list = extractList(json);
  if (!list.recognized) return { recognized: false };

  const services: TailscaleService[] = [];
  for (const raw of list.items) {
    const service = parseOneService(raw);
    if (service) services.push(service);
  }
  return { recognized: true, items: services };
}

type ExtractedList = { recognized: true; items: unknown[] } | { recognized: false };

function extractList(json: unknown): ExtractedList {
  if (Array.isArray(json)) return { recognized: true, items: json };
  if (isRecord(json)) {
    for (const key of ['vipServices', 'services', 'vip-services', 'items']) {
      const value = json[key];
      if (Array.isArray(value)) return { recognized: true, items: value };
    }
  }
  return { recognized: false };
}

function parseOneService(raw: unknown): TailscaleService | undefined {
  if (!isRecord(raw)) return undefined;
  const name = firstString(raw, ['name', 'Name']);
  if (!name) return undefined;

  return {
    name,
    addrs: firstStringArray(raw, ['addrs', 'addresses', 'Addrs', 'Addresses']),
    ports: parsePorts(raw.ports ?? raw.Ports),
    comment: firstString(raw, ['comment', 'Comment']),
  };
}

function parsePorts(raw: unknown): ServicePort[] {
  if (!Array.isArray(raw)) return [];
  const ports: ServicePort[] = [];
  for (const entry of raw) {
    const parsed = parseOnePort(entry);
    if (parsed) ports.push(parsed);
  }
  return ports;
}

const PORT_STRING_RE = /^(?:(tcp|udp)[/:])?(\d+)(?:[/:](tcp|udp))?$/i;

/**
 * Accepts a bare port number, a "80/tcp" / "tcp/80" / "80:tcp" style
 * string, or a `{ port, protocol }` object — the plausible encodings for
 * a field whose real shape is unverified. Defaults to tcp when no
 * protocol is present at all.
 */
function parseOnePort(entry: unknown): ServicePort | undefined {
  if (typeof entry === 'number') {
    return isValidPort(entry) ? { port: entry, protocol: 'tcp' } : undefined;
  }

  if (typeof entry === 'string') {
    const match = PORT_STRING_RE.exec(entry.trim());
    if (!match) return undefined;
    const port = Number(match[2]);
    const protocol = (match[1] ?? match[3] ?? 'tcp').toLowerCase() as 'tcp' | 'udp';
    return isValidPort(port) ? { port, protocol } : undefined;
  }

  if (isRecord(entry)) {
    const portValue = entry.port ?? entry.Port;
    const port = typeof portValue === 'number' ? portValue : Number(portValue);
    const protocol = String(entry.protocol ?? entry.Protocol ?? 'tcp').toLowerCase();
    if (isValidPort(port) && (protocol === 'tcp' || protocol === 'udp')) {
      return { port, protocol };
    }
    return undefined;
  }

  return undefined;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}
