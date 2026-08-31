// Builds the desired set of bookmarks from a tailnet's Devices and
// Services. DESIGN.md "Components": the planner (flight #4) is the only
// place the five convergence rules live; this module's whole job is
// answering "what bookmarks should exist right now" so the planner can
// diff that against what actually exists.
//
// Pure. No browser API, no I/O, no `fetch`, no `browser` global — it
// must run under vitest with no WXT runtime. Time is not an input: no
// `Date.now()`, no filtering on `lastSeen`. DESIGN.md "Open questions"
// books lastSeen filtering as open, and explains why: a time-dependent
// desired set is machine-dependent (two machines polling a second apart
// disagree), which is exactly the kind of disagreement the delete-lag
// rule exists to absorb cheaply, not something worth inviting here for
// free. So every device is included, always.

import type { ServicePort, TailnetData, TailscaleDevice, TailscaleService } from '../tailscale/types';

/** Which slice a desired bookmark came from. The planner (flight #4)
 * needs this on every entry to apply the unknown-slice rule: a slice
 * that failed to fetch must not cause deletes of bookmarks that were
 * previously derived from it. */
export type BookmarkSource = 'devices' | 'services';

export interface DesiredBookmark {
  url: string;
  title: string;
  source: BookmarkSource;
}

/** Source toggles as stored in `storage.sync` (`sourceDevicesEnabled` /
 * `sourceServicesEnabled` per the options page). This module takes them
 * as plain booleans and never reads storage itself. */
export interface SourceToggles {
  devicesEnabled: boolean;
  servicesEnabled: boolean;
}

/** Per-slice status carried alongside the entries, distinct from the
 * per-entry `source` tag: an entry only exists for a URL that IS
 * desired, but the planner also needs to know, for a slice that
 * produced zero or partial entries, whether that means "genuinely
 * nothing here" (ok) or "we don't know" (unknown) — the difference
 * between reconciling a source to empty and leaving it alone. */
export type SliceOutcome = { status: 'ok' } | { status: 'unknown'; reason: string };

/**
 * The desired set, or an explicit failure to compute one at all.
 *
 * `unknown` here is not "zero bookmarks" — see `buildDesiredSet`'s
 * doc comment for exactly when this fires. The whole point of a
 * dedicated status is the same discipline `Slice<T>` uses upstream:
 * never let "we couldn't figure it out" collapse into an empty result
 * that looks like a legitimate "there's nothing here."
 */
export type DesiredSet =
  | {
      status: 'ok';
      /** Derived from the device list (see `deriveTailnetSuffix`), e.g.
       * "tail-scale.ts.net". Also what names the managed folder — that
       * naming itself happens downstream (flight #6); this is the raw
       * derived value. */
      tailnetSuffix: string;
      /** Keyed on URL, per DESIGN.md "Data model": reconciliation keys
       * on URL, which keeps the diff idempotent and lets titles change
       * without churning bookmark ids. */
      entries: Map<string, DesiredBookmark>;
      slices: { devices: SliceOutcome; services: SliceOutcome };
    }
  | { status: 'unknown'; reason: string };

/**
 * Builds the desired bookmark set from a poll's `TailnetData` and the
 * user's source toggles.
 *
 * ## Why devices can force the whole result unknown
 *
 * The tailnet suffix is derived from the device list, never configured
 * (DESIGN.md "Data model"), and it is also what names the managed
 * folder. That makes the devices slice load-bearing for BOTH slices'
 * output, not just its own: a service's URL is `<name>.<suffix>`, so
 * without a suffix there is no folder to locate and no service host to
 * build either. So when the devices slice is `unknown`, or is `ok` but
 * contains no device with a well-formed MagicDNS name to derive a
 * suffix from, this returns `{ status: 'unknown', reason }` for the
 * WHOLE desired set — never a plausible-looking folder name or a
 * services-only result built on a guessed suffix. This mirrors the
 * unknown-vs-empty discipline `Slice<T>` already uses: a folder name
 * computed from nothing is worse than no folder name, because the
 * former looks trustworthy and isn't.
 *
 * This holds even when `devicesEnabled` is false: disabling device
 * bookmarks means "don't bookmark devices," not "stop using the device
 * list to know which tailnet this is." The suffix is derived from the
 * fetched device data regardless of the toggle; only whether device
 * bookmarks are *emitted* depends on it.
 *
 * ## Why services can't do the same
 *
 * The services slice being `unknown`, by contrast, never blocks the
 * result: nothing else depends on it. It just means zero service
 * entries this round, tagged in `slices.services` so the planner knows
 * that's "we don't know," not "the tailnet declares no services" —
 * i.e. it must not delete previously-known service bookmarks on the
 * strength of their absence here.
 */
export function buildDesiredSet(data: TailnetData, toggles: SourceToggles): DesiredSet {
  if (data.devices.status === 'unknown') {
    return {
      status: 'unknown',
      reason: `devices slice is unknown (${data.devices.reason}); the tailnet suffix and the managed folder's name both derive from the device list, so nothing can be computed`,
    };
  }

  const devices = data.devices.items;
  const suffixResult = deriveTailnetSuffix(devices);
  if (!suffixResult.ok) {
    return { status: 'unknown', reason: suffixResult.reason };
  }
  const tailnetSuffix = suffixResult.suffix;

  const entries = new Map<string, DesiredBookmark>();

  // Devices first, then services, so a URL collision between the two
  // (unlikely, but possible if a service's derived host happens to
  // match a device's) is resolved in favor of the service entry. This
  // is deterministic given the same input data on every machine, which
  // is the only property that matters here — see DESIGN.md "Convergent
  // identity".
  if (toggles.devicesEnabled) {
    for (const device of devices) {
      const entry = buildDeviceEntry(device);
      if (entry) entries.set(entry.url, entry);
    }
  }

  const services = data.services;
  if (toggles.servicesEnabled && services.status === 'ok') {
    for (const service of services.items) {
      const entry = buildServiceEntry(service, tailnetSuffix);
      if (entry) entries.set(entry.url, entry);
    }
  }

  return {
    status: 'ok',
    tailnetSuffix,
    entries,
    slices: {
      devices: { status: 'ok' },
      services: services.status === 'ok' ? { status: 'ok' } : { status: 'unknown', reason: services.reason },
    },
  };
}

// ---------------------------------------------------------------------
// Tailnet suffix
// ---------------------------------------------------------------------

type SuffixResult = { ok: true; suffix: string } | { ok: false; reason: string };

/**
 * Derives the tailnet suffix (e.g. "tail-scale.ts.net" from
 * "pi.tail-scale.ts.net") from the device list.
 *
 * Decision: only devices whose `name` is a well-formed MagicDNS name
 * (see `isWellFormedMagicDnsName`) count. If every device agrees on the
 * suffix, that is the answer. If devices disagree — which should not
 * happen in practice, since one OAuth client reads exactly one tailnet,
 * but a malformed or stale entry could produce a spurious one — the
 * suffix with the most devices wins, ties broken alphabetically. Both
 * the counting and the tie-break depend only on the device data itself,
 * never on array order or any other incidental detail of the response,
 * so two machines reading the same tailnet always derive the same
 * suffix (DESIGN.md "Convergent identity": machines must compute the
 * same answer for agreement to cost nothing).
 *
 * If no device has a well-formed name at all, there is no suffix to
 * derive and this reports failure explicitly rather than guessing.
 */
function deriveTailnetSuffix(devices: TailscaleDevice[]): SuffixResult {
  const counts = new Map<string, number>();
  for (const device of devices) {
    if (!isWellFormedMagicDnsName(device.name)) continue;
    const suffix = splitMagicDnsName(device.name).suffix.toLowerCase();
    counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return {
      ok: false,
      reason: 'no device has a well-formed MagicDNS name ("host.tailnet-name.ts.net") to derive the tailnet suffix from',
    };
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // counts.size > 0 was just checked above, so ranked has at least one entry.
  const [suffix] = ranked[0]!;
  return { ok: true, suffix };
}

/** At least two dot-separated DNS labels, e.g. "host.tailnet.ts.net".
 * A single-label name ("host", no dot) has no suffix to split off and
 * is excluded both from suffix derivation and from becoming a device
 * bookmark — there is no confidence it is even the right domain, the
 * same "skip the malformed row rather than fail the whole read"
 * discipline parse.ts already uses for a device missing id/name. */
const DNS_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const MAGICDNS_NAME_RE = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})+$`, 'i');

function isWellFormedMagicDnsName(name: string): boolean {
  return MAGICDNS_NAME_RE.test(name.trim());
}

function splitMagicDnsName(name: string): { host: string; suffix: string } {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  return { host: trimmed.slice(0, dot), suffix: trimmed.slice(dot + 1) };
}

// ---------------------------------------------------------------------
// Devices -> bookmark
// ---------------------------------------------------------------------

/**
 * A device becomes a bare-host bookmark at `https://<name>/`.
 *
 * Decision: scheme is always `https` — nothing in a device record signals
 * otherwise (there is no port list to read, unlike services), and https
 * is the safer default to bookmark: a wrong guess fails loudly with a
 * connection error rather than silently degrading. The host is
 * lower-cased because it feeds the URL that reconciliation keys on
 * (DESIGN.md "Data model"); inconsistent casing across polls or
 * machines would otherwise look like a different bookmark.
 *
 * Decision: the title is the device's Tailscale machine name — the first
 * label of its MagicDNS `name`, which is what the admin console shows and
 * what a rename there changes. The API's `hostname` field is deliberately
 * not consulted: it is the OS-reported hostname, and iOS reports
 * `localhost` for every device, so titling from it puts a bookmark called
 * "localhost" in the folder for each iPhone. The machine name cannot be
 * localhost and is unique within a tailnet, because MagicDNS makes it so.
 *
 * The cost is capitalization. MagicDNS labels are lowercase and
 * hyphenated, so a device the OS calls "TJ MacBook Pro 2" is titled
 * "tj-macbook-pro-2" here. That prettiness is what `hostname` was buying,
 * and it is traded for a title that is always correct and always agrees
 * with the console.
 *
 * A device whose `name` isn't a well-formed MagicDNS name is skipped
 * entirely (see `isWellFormedMagicDnsName`) rather than emitting a
 * bookmark built from an unverified guess at its shape.
 */
function buildDeviceEntry(device: TailscaleDevice): DesiredBookmark | undefined {
  if (!isWellFormedMagicDnsName(device.name)) return undefined;

  const host = device.name.trim().toLowerCase();
  const title = splitMagicDnsName(host).host;
  return { url: `https://${host}/`, title, source: 'devices' };
}

// ---------------------------------------------------------------------
// Services -> bookmark
// ---------------------------------------------------------------------

/**
 * A service becomes a bookmark at `<scheme>://<short-name>.<tailnetSuffix>[:<port>]/`.
 *
 * Decision: the short name strips a leading "svc:" (case-insensitive) —
 * the naming convention every fixture and test in `tailscale/` uses for
 * a VIP service's `name` field — and what remains must itself be a
 * valid single DNS label, or the service is skipped as malformed. This
 * assumes a VIP service is reachable at `<short-name>.<tailnet-suffix>`,
 * the same MagicDNS pattern devices use; DESIGN.md books the
 * vip-services response shape itself as UNVERIFIED, and this host
 * construction is equally unverified against a live tailnet for the
 * same reason.
 *
 * Decision: scheme and port selection reads only `protocol: 'tcp'`
 * ports — a raw UDP port has no browser-navigable scheme, so a service
 * advertising only UDP ports (or no ports at all) produces no bookmark.
 * Among the TCP ports:
 *   - 443 present -> `https`, no port in the URL (its default port).
 *   - else 80 present -> `http`, no port in the URL (its default port).
 *   - else -> `http` on the lowest-numbered TCP port, written explicitly,
 *     since there's no way to know the service actually speaks TLS on
 *     the port an admin happened to declare it against, and picking the
 *     lowest keeps the choice deterministic across polls and machines
 *     regardless of the array order a response happens to list ports in.
 *
 * The comment becomes the title, falling back to the service name (its
 * raw `name`, "svc:"-prefix included, per the flight brief) when the
 * comment is missing or blank — the fixtures use `comment: ''` for
 * "none declared", so an empty string is treated the same as absent.
 */
function buildServiceEntry(service: TailscaleService, tailnetSuffix: string): DesiredBookmark | undefined {
  const shortName = stripServicePrefix(service.name);
  if (!DNS_LABEL_ONLY_RE.test(shortName)) return undefined;

  const picked = pickSchemeAndPort(service.ports);
  if (!picked) return undefined;

  const host = `${shortName.toLowerCase()}.${tailnetSuffix}`;
  const portSuffix = picked.port === undefined ? '' : `:${picked.port}`;
  const title = service.comment?.trim() ? service.comment.trim() : service.name;

  return { url: `${picked.scheme}://${host}${portSuffix}/`, title, source: 'services' };
}

const DNS_LABEL_ONLY_RE = new RegExp(`^${DNS_LABEL}$`, 'i');

function stripServicePrefix(name: string): string {
  const trimmed = name.trim();
  return /^svc:/i.test(trimmed) ? trimmed.slice(4) : trimmed;
}

function pickSchemeAndPort(ports: ServicePort[]): { scheme: 'http' | 'https'; port?: number } | undefined {
  const tcpPorts = ports.filter((p) => p.protocol === 'tcp').map((p) => p.port);
  if (tcpPorts.length === 0) return undefined;
  if (tcpPorts.includes(443)) return { scheme: 'https' };
  if (tcpPorts.includes(80)) return { scheme: 'http' };
  return { scheme: 'http', port: Math.min(...tcpPorts) };
}
