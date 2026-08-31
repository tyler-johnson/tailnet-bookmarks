// Hand-built fixtures for the raw JSON bodies this module parses. There
// is no live tailnet or credentials available while building this flight
// (see the flight brief) — DESIGN.md itself books the vip-services shape
// as unverified — so nothing here has been checked against a real
// response. It is built from Tailscale's public API reference and used
// only by this module's own tests.
//
// CONFIRMED against https://tailscale.com/api:
//  - the oauth/token response shape (access_token, token_type, expires_in)
//  - the devices response envelope and the fields parse.ts reads off it
//
// INFERRED / UNVERIFIED (DESIGN.md "Known limits" — "Service response
// shape unverified"):
//  - the vip-services top-level key: `vipServices` is used below;
//    `services`, `vip-services`, `items`, and a bare array are also
//    accepted by parseVipServicesResponse (see parse.ts)
//  - port formatting: `"80/tcp"`-style strings are used below; the
//    parser also accepts bare numbers, `"tcp/80"` / `"tcp:80"`, and
//    `{ port, protocol }` objects

export const tokenResponseFixture = {
  access_token: 'fixture-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
};

export const devicesResponseFixture = {
  devices: [
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
  ],
};

// INFERRED shape — see header comment.
export const vipServicesResponseFixture = {
  vipServices: [
    {
      name: 'svc:grafana',
      addrs: ['100.100.100.50'],
      ports: ['3000/tcp'],
      comment: 'Grafana dashboards',
    },
    {
      name: 'svc:paperless',
      addrs: ['100.100.100.51'],
      ports: ['80/tcp', '443/tcp'],
      comment: '',
    },
  ],
};
