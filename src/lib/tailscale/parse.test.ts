import { describe, expect, it } from 'vitest';
import { devicesResponseFixture, vipServicesResponseFixture } from './fixtures';
import { parseDevicesResponse, parseVipServicesResponse, TailscaleParseError } from './parse';

describe('parseDevicesResponse', () => {
  it('parses the confirmed devices envelope', () => {
    const devices = parseDevicesResponse(devicesResponseFixture);
    expect(devices).toEqual([
      {
        id: 'n1CNTRL',
        name: 'pi.tail-scale.ts.net',
        hostname: 'pi',
        addresses: ['100.100.100.1'],
        os: 'linux',
        authorized: true,
        lastSeen: '2026-08-30T12:00:00Z',
      },
      {
        id: 'n2CNTRL',
        name: 'starforge.tail-scale.ts.net',
        hostname: 'starforge',
        addresses: ['100.100.100.2'],
        os: 'windows',
        authorized: true,
        lastSeen: '2026-08-31T09:00:00Z',
      },
    ]);
  });

  it('throws TailscaleParseError when the devices envelope is missing', () => {
    expect(() => parseDevicesResponse({ notDevices: [] })).toThrow(TailscaleParseError);
    expect(() => parseDevicesResponse(null)).toThrow(TailscaleParseError);
    expect(() => parseDevicesResponse('garbage')).toThrow(TailscaleParseError);
  });

  it('skips malformed entries but keeps the good ones', () => {
    const devices = parseDevicesResponse({
      devices: [
        { id: 'ok1', name: 'a.ts.net' },
        { name: 'missing-id.ts.net' },
        { id: 'missing-name' },
        'not even an object',
        { id: 'ok2', name: 'b.ts.net', hostname: 'b', addresses: ['100.1.1.1'], os: 'linux', authorized: false, lastSeen: 'x' },
      ],
    });
    expect(devices.map((d) => d.id)).toEqual(['ok1', 'ok2']);
  });

  it('derives hostname from the FQDN when hostname is absent', () => {
    const devices = parseDevicesResponse({ devices: [{ id: 'n1', name: 'myhost.tailnet.ts.net' }] });
    expect(devices[0]?.hostname).toBe('myhost');
  });

  it('defaults authorized to true and other optional fields to safe empties', () => {
    const devices = parseDevicesResponse({ devices: [{ id: 'n1', name: 'myhost.tailnet.ts.net' }] });
    expect(devices[0]).toMatchObject({ authorized: true, addresses: [], os: '', lastSeen: '' });
  });
});

describe('parseVipServicesResponse', () => {
  it('parses the inferred vipServices envelope', () => {
    const services = parseVipServicesResponse(vipServicesResponseFixture);
    expect(services).toEqual([
      { name: 'svc:grafana', addrs: ['100.100.100.50'], ports: [{ port: 3000, protocol: 'tcp' }], comment: 'Grafana dashboards' },
      { name: 'svc:paperless', addrs: ['100.100.100.51'], ports: [{ port: 80, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }], comment: '' },
    ]);
  });

  it('also accepts a "services" envelope', () => {
    const services = parseVipServicesResponse({ services: [{ name: 'svc:x', addrs: [], ports: [] }] });
    expect(services).toEqual([{ name: 'svc:x', addrs: [], ports: [], comment: undefined }]);
  });

  it('also accepts a bare array', () => {
    const services = parseVipServicesResponse([{ name: 'svc:x', addrs: [], ports: [] }]);
    expect(services.map((s) => s.name)).toEqual(['svc:x']);
  });

  it('never throws on an unrecognized top-level shape, and returns no items', () => {
    expect(parseVipServicesResponse(null)).toEqual([]);
    expect(parseVipServicesResponse('garbage')).toEqual([]);
    expect(parseVipServicesResponse(42)).toEqual([]);
    expect(parseVipServicesResponse({ somethingElse: true })).toEqual([]);
  });

  it('skips entries with no usable name', () => {
    const services = parseVipServicesResponse({ vipServices: [{ addrs: [], ports: [] }, { name: 'svc:ok', addrs: [], ports: [] }] });
    expect(services.map((s) => s.name)).toEqual(['svc:ok']);
  });

  describe('port formats', () => {
    it('accepts bare numbers', () => {
      const [service] = parseVipServicesResponse({ vipServices: [{ name: 'svc:x', ports: [80, 443] }] });
      expect(service!.ports).toEqual([
        { port: 80, protocol: 'tcp' },
        { port: 443, protocol: 'tcp' },
      ]);
    });

    it('accepts "port/proto" and "proto/port" and "proto:port" strings', () => {
      const [service] = parseVipServicesResponse({
        vipServices: [{ name: 'svc:x', ports: ['80/tcp', 'udp/53', 'tcp:22', '8080'] }],
      });
      expect(service!.ports).toEqual([
        { port: 80, protocol: 'tcp' },
        { port: 53, protocol: 'udp' },
        { port: 22, protocol: 'tcp' },
        { port: 8080, protocol: 'tcp' },
      ]);
    });

    it('accepts {port, protocol} objects', () => {
      const [service] = parseVipServicesResponse({
        vipServices: [{ name: 'svc:x', ports: [{ port: 51820, protocol: 'udp' }] }],
      });
      expect(service!.ports).toEqual([{ port: 51820, protocol: 'udp' }]);
    });

    it('drops unparseable or out-of-range port entries without failing the service', () => {
      const [service] = parseVipServicesResponse({
        vipServices: [{ name: 'svc:x', ports: ['not-a-port', 0, -1, 70000, { protocol: 'tcp' }, 443] }],
      });
      expect(service!.ports).toEqual([{ port: 443, protocol: 'tcp' }]);
    });
  });
});
