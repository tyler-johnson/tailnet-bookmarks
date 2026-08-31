// Module surface for the `tailscale` component (DESIGN.md "Components").
// Flight #3 (desired-set model) consumes the types and the Slice<T>
// shape; flight #6 (applier and background run loop) calls
// fetchTailnetData and createSessionTokenStore. Neither wires into
// background.ts or the options page here — that's their flight, not
// this one.

export {
  fetchAccessToken,
  fetchDevices,
  fetchServices,
  fetchTailnetData,
  getAccessToken,
  TailscaleAuthError,
} from './client';
export type { FetchTailnetDataOptions } from './client';

export { parseDevicesResponse, parseVipServicesResponse, TailscaleParseError } from './parse';
export type { VipServicesParseResult } from './parse';

export { createSessionTokenStore } from './session-store';
export type { SessionKV } from './session-store';

export type {
  CachedToken,
  ServicePort,
  Slice,
  TailnetData,
  TailscaleCredentials,
  TailscaleDevice,
  TailscaleService,
  TokenStore,
} from './types';
