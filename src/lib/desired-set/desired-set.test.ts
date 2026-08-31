import { describe, expect, it } from 'vitest';

import { devicesResponseFixture, vipServicesResponseFixture } from '../tailscale/fixtures';
import { parseVipServicesResponse } from '../tailscale/parse';
import type { Slice, TailnetData, TailscaleDevice, TailscaleService } from '../tailscale/types';

import { buildDesiredSet } from './desired-set';
import type { DesiredBookmark, DesiredSet, SourceToggles } from './desired-set';

// Real devices from the shared fixture (flight brief: "Recorded fixtures
// already exist at src/lib/tailscale/fixtures.ts — reuse them rather
// than inventing a second set"). The fixture's raw JSON already matches
// TailscaleDevice field-for-field.
const baseDevices: TailscaleDevice[] = devicesResponseFixture.devices;

// Run the shared services fixture through the real parser so the
// desired-set tests exercise the same TailscaleService shape the rest
// of the extension actually produces, ports included.
const parsedServices = parseVipServicesResponse(vipServicesResponseFixture);
if (!parsedServices.recognized) throw new Error('fixture must parse');
const baseServices: TailscaleService[] = parsedServices.items;

const BOTH_ON: SourceToggles = { devicesEnabled: true, servicesEnabled: true };

function okSlice<T>(items: T[]): Slice<T> {
  return { status: 'ok', items };
}

function unknownSlice<T>(reason: string): Slice<T> {
  return { status: 'unknown', reason };
}

function device(overrides: Partial<TailscaleDevice>): TailscaleDevice {
  return {
    id: 'nX',
    name: 'host.tail-scale.ts.net',
    hostname: 'host',
    addresses: ['100.100.100.9'],
    os: 'linux',
    authorized: true,
    lastSeen: '',
    ...overrides,
  };
}

function service(overrides: Partial<TailscaleService>): TailscaleService {
  return { name: 'svc:x', addrs: [], ports: [{ port: 443, protocol: 'tcp' }], ...overrides };
}

/** Sorted array view of a successful result's entries, for order-independent assertions. */
function entriesOf(result: DesiredSet): DesiredBookmark[] {
  if (result.status !== 'ok') throw new Error(`expected an ok result, got unknown: ${result.reason}`);
  return [...result.entries.values()].sort((a, b) => a.url.localeCompare(b.url));
}

describe('buildDesiredSet', () => {
  it('builds device and service bookmarks from realistic fixture data', () => {
    const data: TailnetData = { devices: okSlice(baseDevices), services: okSlice(baseServices) };
    const result = buildDesiredSet(data, BOTH_ON);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tailnetSuffix).toBe('tail-scale.ts.net');
    expect(result.slices).toEqual({ devices: { status: 'ok' }, services: { status: 'ok' } });

    expect(entriesOf(result)).toEqual([
      { url: 'http://grafana.tail-scale.ts.net:3000/', title: 'Grafana dashboards', source: 'services' },
      // paperless declares ports 80 and 443; 443 wins so no port in the URL.
      { url: 'https://paperless.tail-scale.ts.net/', title: 'svc:paperless', source: 'services' },
      { url: 'https://pi.tail-scale.ts.net/', title: 'pi', source: 'devices' },
      { url: 'https://starforge.tail-scale.ts.net/', title: 'starforge', source: 'devices' },
    ]);
  });

  it('is keyed on URL: entries is a Map addressable by the bookmark URL', () => {
    const data: TailnetData = { devices: okSlice(baseDevices), services: unknownSlice('n/a') };
    const result = buildDesiredSet(data, BOTH_ON);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entries.get('https://pi.tail-scale.ts.net/')).toEqual({
      url: 'https://pi.tail-scale.ts.net/',
      title: 'pi',
      source: 'devices',
    });
  });

  describe('devices slice unknown forces the whole result unknown', () => {
    it('when the devices slice itself failed to fetch', () => {
      const data: TailnetData = { devices: unknownSlice('network error'), services: okSlice(baseServices) };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('unknown');
      if (result.status !== 'unknown') return;
      expect(result.reason).toContain('network error');
    });

    it('when the devices slice is ok but empty — no device to derive a suffix from', () => {
      const data: TailnetData = { devices: okSlice([]), services: okSlice(baseServices) };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('unknown');
      if (result.status !== 'unknown') return;
      expect(result.reason).toContain('no device has a well-formed MagicDNS name');
    });

    it('when every device name is malformed', () => {
      const data: TailnetData = {
        devices: okSlice([device({ name: 'not-a-fqdn' }), device({ name: 'also-bare' })]),
        services: okSlice([]),
      };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('unknown');
    });

    it('holds even when devicesEnabled is false — the suffix still depends on the device fetch', () => {
      const data: TailnetData = { devices: unknownSlice('timeout'), services: okSlice(baseServices) };
      const result = buildDesiredSet(data, { devicesEnabled: false, servicesEnabled: true });
      expect(result.status).toBe('unknown');
    });
  });

  it('skips a malformed device name without blocking suffix derivation or other devices', () => {
    const data: TailnetData = {
      devices: okSlice([device({ name: 'pi.tail-scale.ts.net', hostname: 'pi' }), device({ name: 'no-dot-here', hostname: 'ghost' })]),
      services: okSlice([]),
    };
    const result = buildDesiredSet(data, BOTH_ON);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.tailnetSuffix).toBe('tail-scale.ts.net');
    expect(entriesOf(result)).toEqual([{ url: 'https://pi.tail-scale.ts.net/', title: 'pi', source: 'devices' }]);
  });

  describe('suffix disagreement between devices', () => {
    it('resolves by majority vote', () => {
      const data: TailnetData = {
        devices: okSlice([
          device({ id: 'n1', name: 'a.majority.ts.net', hostname: 'a' }),
          device({ id: 'n2', name: 'b.majority.ts.net', hostname: 'b' }),
          device({ id: 'n3', name: 'c.minority.ts.net', hostname: 'c' }),
        ]),
        services: okSlice([]),
      };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.tailnetSuffix).toBe('majority.ts.net');
    });

    it('breaks a tie alphabetically, so every machine picks the same winner', () => {
      const data: TailnetData = {
        devices: okSlice([
          device({ id: 'n1', name: 'a.zzz.ts.net', hostname: 'a' }),
          device({ id: 'n2', name: 'b.aaa.ts.net', hostname: 'b' }),
        ]),
        services: okSlice([]),
      };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.tailnetSuffix).toBe('aaa.ts.net');
    });

    it('is case-insensitive: differently-cased names still agree on one suffix', () => {
      const data: TailnetData = {
        devices: okSlice([
          device({ id: 'n1', name: 'PI.Tail-Scale.TS.NET', hostname: 'pi' }),
          device({ id: 'n2', name: 'starforge.tail-scale.ts.net', hostname: 'starforge' }),
        ]),
        services: okSlice([]),
      };
      const result = buildDesiredSet(data, BOTH_ON);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.tailnetSuffix).toBe('tail-scale.ts.net');
      expect(entriesOf(result)).toEqual([
        { url: 'https://pi.tail-scale.ts.net/', title: 'pi', source: 'devices' },
        { url: 'https://starforge.tail-scale.ts.net/', title: 'starforge', source: 'devices' },
      ]);
    });
  });

  describe('source toggles', () => {
    it('devicesEnabled: false omits device entries but the suffix and services are unaffected', () => {
      const data: TailnetData = { devices: okSlice(baseDevices), services: okSlice(baseServices) };
      const result = buildDesiredSet(data, { devicesEnabled: false, servicesEnabled: true });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.tailnetSuffix).toBe('tail-scale.ts.net');
      expect(entriesOf(result).every((e) => e.source === 'services')).toBe(true);
      expect(entriesOf(result)).toHaveLength(2);
    });

    it('servicesEnabled: false omits service entries', () => {
      const data: TailnetData = { devices: okSlice(baseDevices), services: okSlice(baseServices) };
      const result = buildDesiredSet(data, { devicesEnabled: true, servicesEnabled: false });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(entriesOf(result).every((e) => e.source === 'devices')).toBe(true);
      expect(entriesOf(result)).toHaveLength(2);
    });
  });

  it('an unknown services slice yields zero service entries but an ok overall result, tagged for the planner', () => {
    const data: TailnetData = { devices: okSlice(baseDevices), services: unknownSlice('500 from vip-services') };
    const result = buildDesiredSet(data, BOTH_ON);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.slices).toEqual({
      devices: { status: 'ok' },
      services: { status: 'unknown', reason: '500 from vip-services' },
    });
    expect(entriesOf(result).every((e) => e.source === 'devices')).toBe(true);
  });

  describe('service port -> scheme/port rule', () => {
    const suffixOnly: TailnetData = { devices: okSlice(baseDevices), services: okSlice([]) };

    function servicesUrl(ports: TailscaleService['ports']) {
      const data: TailnetData = { ...suffixOnly, services: okSlice([service({ name: 'svc:x', ports })]) };
      const result = buildDesiredSet(data, BOTH_ON);
      if (result.status !== 'ok') throw new Error('expected ok');
      const entry = [...result.entries.values()].find((e) => e.source === 'services');
      return entry?.url;
    }

    it('443/tcp present -> https, default port omitted', () => {
      expect(servicesUrl([{ port: 443, protocol: 'tcp' }])).toBe('https://x.tail-scale.ts.net/');
    });

    it('80/tcp present (no 443) -> http, default port omitted', () => {
      expect(servicesUrl([{ port: 80, protocol: 'tcp' }])).toBe('http://x.tail-scale.ts.net/');
    });

    it('both 80 and 443 -> https wins, regardless of array order', () => {
      expect(servicesUrl([{ port: 80, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }])).toBe('https://x.tail-scale.ts.net/');
      expect(servicesUrl([{ port: 443, protocol: 'tcp' }, { port: 80, protocol: 'tcp' }])).toBe('https://x.tail-scale.ts.net/');
    });

    it('neither 80 nor 443 -> http on the lowest tcp port, written explicitly', () => {
      expect(servicesUrl([{ port: 3000, protocol: 'tcp' }])).toBe('http://x.tail-scale.ts.net:3000/');
    });

    it('picks the lowest port deterministically, regardless of array order', () => {
      expect(servicesUrl([{ port: 8080, protocol: 'tcp' }, { port: 3000, protocol: 'tcp' }])).toBe(
        'http://x.tail-scale.ts.net:3000/',
      );
      expect(servicesUrl([{ port: 3000, protocol: 'tcp' }, { port: 8080, protocol: 'tcp' }])).toBe(
        'http://x.tail-scale.ts.net:3000/',
      );
    });

    it('udp-only ports produce no bookmark for that service', () => {
      expect(servicesUrl([{ port: 53, protocol: 'udp' }])).toBeUndefined();
    });

    it('no ports at all produces no bookmark', () => {
      expect(servicesUrl([])).toBeUndefined();
    });

    it('a mix of udp and tcp only considers the tcp ports', () => {
      expect(servicesUrl([{ port: 3000, protocol: 'udp' }, { port: 443, protocol: 'tcp' }])).toBe(
        'https://x.tail-scale.ts.net/',
      );
    });
  });

  describe('service title', () => {
    function titleFor(overrides: Partial<TailscaleService>) {
      const data: TailnetData = { devices: okSlice(baseDevices), services: okSlice([service(overrides)]) };
      const result = buildDesiredSet(data, BOTH_ON);
      if (result.status !== 'ok') throw new Error('expected ok');
      const entry = [...result.entries.values()].find((e) => e.source === 'services');
      return entry?.title;
    }

    it('uses the comment when present', () => {
      expect(titleFor({ name: 'svc:grafana', comment: 'Grafana dashboards' })).toBe('Grafana dashboards');
    });

    it('falls back to the service name when the comment is an empty string', () => {
      expect(titleFor({ name: 'svc:paperless', comment: '' })).toBe('svc:paperless');
    });

    it('falls back to the service name when the comment is whitespace only', () => {
      expect(titleFor({ name: 'svc:paperless', comment: '   ' })).toBe('svc:paperless');
    });

    it('falls back to the service name when the comment is absent', () => {
      expect(titleFor({ name: 'svc:paperless', comment: undefined })).toBe('svc:paperless');
    });
  });

  describe('service short name', () => {
    function urlFor(name: string) {
      const data: TailnetData = { devices: okSlice(baseDevices), services: okSlice([service({ name })]) };
      const result = buildDesiredSet(data, BOTH_ON);
      if (result.status !== 'ok') throw new Error('expected ok');
      const entry = [...result.entries.values()].find((e) => e.source === 'services');
      return entry?.url;
    }

    it('strips a leading "svc:" case-insensitively', () => {
      expect(urlFor('svc:grafana')).toBe('https://grafana.tail-scale.ts.net/');
      expect(urlFor('SVC:grafana')).toBe('https://grafana.tail-scale.ts.net/');
    });

    it('uses the name as-is when there is no "svc:" prefix', () => {
      expect(urlFor('grafana')).toBe('https://grafana.tail-scale.ts.net/');
    });

    it('skips a service whose name is empty after stripping the prefix', () => {
      expect(urlFor('svc:')).toBeUndefined();
    });

    it('skips a service whose short name is not a valid DNS label', () => {
      expect(urlFor('svc:my service')).toBeUndefined();
      expect(urlFor('svc:has_underscore')).toBeUndefined();
    });
  });

  it('resolves a URL collision between a device and a service deterministically, in favor of the service', () => {
    const data: TailnetData = {
      devices: okSlice([device({ name: 'grafana.tail-scale.ts.net', hostname: 'grafana' })]),
      services: okSlice([service({ name: 'svc:grafana', comment: 'Dashboards', ports: [{ port: 443, protocol: 'tcp' }] })]),
    };
    const result = buildDesiredSet(data, BOTH_ON);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entries.size).toBe(1);
    expect(result.entries.get('https://grafana.tail-scale.ts.net/')).toEqual({
      url: 'https://grafana.tail-scale.ts.net/',
      title: 'Dashboards',
      source: 'services',
    });
  });
});
