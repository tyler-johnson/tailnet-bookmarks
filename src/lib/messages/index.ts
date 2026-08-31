// Module surface for the `messages` component. Shared between the options
// page and the popup — see messages.ts's header for the contract and why
// this moved out of src/entrypoints/options (flight #10, the same reasoning
// flight #6 applied to storage).

export { MANUAL_SYNC_MESSAGE_TYPE, isManualSyncResponse } from './messages';
export type { ManualSyncRequest, ManualSyncResponse } from './messages';
