// Storage schema for the options page, split by sensitivity exactly as
// DESIGN.md "Auth" specifies:
//
//   storage.local  — per machine, never synced. The OAuth client id and
//                    secret (entered once per machine; DESIGN.md is explicit
//                    that the secret must never leave the machine it was
//                    typed on, and the id travels with it since the pair is
//                    meaningless split apart) plus this machine's last
//                    sync-run status.
//   storage.sync   — replicated to every machine on the account, so every
//                    machine computes the same desired bookmark set: folder
//                    parent, poll interval, and the per-source toggles.
//
// This module is options-owned, but the shapes below are the contract
// flight #6 (background) reads and writes against — see the last-run status
// section and the closing flight comment for the exact types.

import { storage } from '#imports';

export const TAILSCALE_ORIGIN = 'https://api.tailscale.com/*';

// --- storage.local: OAuth client credentials -------------------------------

export const oauthClientId = storage.defineItem<string>('local:oauthClientId', {
  fallback: '',
});

export const oauthClientSecret = storage.defineItem<string>('local:oauthClientSecret', {
  fallback: '',
});

// --- storage.sync: shared config, same desired set on every machine --------

export const DEFAULT_FOLDER_PARENT = 'Other Bookmarks';
export const DEFAULT_POLL_INTERVAL_MINUTES = 30;

// Identified by title, not id: DESIGN.md "Convergent identity" is explicit
// that a bookmark node's local id is not portable between machines, so the
// parent folder a machine syncs against is resolved by walking the tree by
// title at run time (same as the managed folder itself), never by a cached
// id. A plain folder name (e.g. "Other Bookmarks", "Bookmarks Toolbar", or
// any folder the user already created) is what travels through sync.
export const folderParent = storage.defineItem<string>('sync:folderParent', {
  fallback: DEFAULT_FOLDER_PARENT,
});

export const pollIntervalMinutes = storage.defineItem<number>('sync:pollIntervalMinutes', {
  fallback: DEFAULT_POLL_INTERVAL_MINUTES,
});

export const sourceDevicesEnabled = storage.defineItem<boolean>('sync:sourceDevicesEnabled', {
  fallback: true,
});

export const sourceServicesEnabled = storage.defineItem<boolean>('sync:sourceServicesEnabled', {
  fallback: true,
});

// --- storage.local: last-run status contract --------------------------------
//
// Key: `local:lastRunStatus`. Written by background (#6) at the start and
// end of every reconcile run (alarm-triggered or manual); read here to
// render status, including the "never run" state.
//
// No value in storage (getValue() resolves `null`, the WxtStorageItem
// default with no `fallback`) IS the never-run state — background does not
// need to seed anything before its first run.
export type LastRunStatus =
  | { state: 'running'; startedAt: number }
  | {
      state: 'ok';
      startedAt: number;
      finishedAt: number;
      created: number;
      updated: number;
      removed: number;
    }
  | { state: 'error'; startedAt: number; finishedAt: number; message: string };

export const lastRunStatus = storage.defineItem<LastRunStatus>('local:lastRunStatus');
