// Module surface for the `storage` component (DESIGN.md "Components").
// Shared between the options page and the background run loop — see
// storage.ts's header for the sensitivity split and why this moved out of
// src/entrypoints/options.

export {
  TAILSCALE_ORIGIN,
  oauthClientId,
  oauthClientSecret,
  DEFAULT_FOLDER_PARENT,
  DEFAULT_POLL_INTERVAL_MINUTES,
  folderParent,
  pollIntervalMinutes,
  sourceDevicesEnabled,
  sourceServicesEnabled,
  lastRunStatus,
  firstMissingAt,
  resolveFolderRoots,
  resolveFolderRootId,
} from './storage';

export type { FolderRootSymbol, LastRunStatus, FolderRootMatch } from './storage';
