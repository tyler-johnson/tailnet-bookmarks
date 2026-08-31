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

/**
 * Parses `GET /api/v2/tailnet/-/vip-services`. UNVERIFIED shape (see
 * types.ts and DESIGN.md "Known limits"). This never throws: an
 * unrecognized top-level shape yields zero items rather than an error,
 * because a 200 response means the fetch itself succeeded — client.ts
 * only produces an "unknown" slice from a failed request (network error,
 * non-2xx status, or a body that isn't JSON at all), never from a
 * surprising-but-valid JSON shape. A handful of plausible envelopes and
 * port encodings are accepted; anything else is dropped per-entry.
 */
export function parseVipServicesResponse(json: unknown): TailscaleService[] {
  const rawList = extractList(json);
  const services: TailscaleService[] = [];
  for (const raw of rawList) {
    const service = parseOneService(raw);
    if (service) services.push(service);
  }
  return services;
}

function extractList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json)) {
    for (const key of ['vipServices', 'services', 'vip-services', 'items']) {
      const value = json[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
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
