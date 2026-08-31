// Manual-sync message contract between the options page and background.
//
// Background does not exist yet (flight #6). This is the shape the options
// page sends today and background is expected to answer with once it lands
// — see the closing flight comment for the exact obligation.

export const MANUAL_SYNC_MESSAGE_TYPE = 'tailnet-bookmarks:manual-sync' as const;

export interface ManualSyncRequest {
  type: typeof MANUAL_SYNC_MESSAGE_TYPE;
}

export type ManualSyncResponse = { ok: true } | { ok: false; error: string };

export function isManualSyncResponse(value: unknown): value is ManualSyncResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok: unknown }).ok === 'boolean'
  );
}
