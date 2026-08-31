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
// section, the FolderRootSymbol section, and the closing flight comment for
// the exact types.

import { storage } from '#imports';
import type { Browser } from 'wxt/browser';

export const TAILSCALE_ORIGIN = 'https://api.tailscale.com/*';

// --- storage.local: OAuth client credentials -------------------------------

export const oauthClientId = storage.defineItem<string>('local:oauthClientId', {
  fallback: '',
});

export const oauthClientSecret = storage.defineItem<string>('local:oauthClientSecret', {
  fallback: '',
});

// --- storage.sync: shared config, same desired set on every machine --------

// A symbol, never a title or an id. Root folder titles are localized (a
// German Firefox's "Other Bookmarks" is "Andere Lesezeichen") and Chromium
// and Firefox spell their roots differently from each other ("Other
// bookmarks"/"Bookmarks bar" vs. "Other Bookmarks"/"Bookmarks Toolbar"), so
// neither a title nor a default title is portable — and free text can't
// tell a typo from a folder that's genuinely missing. A symbol is portable
// where both a title and a node id are not (DESIGN.md "Convergent
// identity"). Resolving the symbol to *this machine's* local root id is
// flight #6's job, at reconcile time — see resolveFolderRootId below, which
// options also uses, read-only, to label the picker with this browser's
// own words.
export type FolderRootSymbol = 'toolbar' | 'menu' | 'other';

export const DEFAULT_FOLDER_PARENT: FolderRootSymbol = 'other';
export const DEFAULT_POLL_INTERVAL_MINUTES = 30;

export const folderParent = storage.defineItem<FolderRootSymbol>('sync:folderParent', {
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

// --- symbol → local root id -------------------------------------------------
//
// Exported so #6 writes this mapping once, not twice. Given the live tree
// from `browser.bookmarks.getTree()`, finds each symbol's corresponding
// top-level node on *this* machine and returns its real (localized) id and
// title — never a hardcoded guess independent of what the tree actually
// contains.
//
// Two signals, in order:
//   1. `folderType` (Chrome 134+): an explicit, localization-proof tag —
//      'bookmarks-bar' / 'other'. Chrome has no 'menu' equivalent.
//   2. The id each engine assigns at profile creation, which is stable in
//      practice though not a documented contract: Firefox's
//      `toolbar_____` / `menu________` / `unfiled_____`; older/plain
//      Chromium's `'1'` (bar) / `'2'` (other).
//
// A symbol with no match under either signal resolves to `null` — the
// "sensible fallback" is to say so plainly, not to guess a folder and
// silently write to the wrong one (the same unknown-vs-empty discipline
// DESIGN.md's "Per-source slices" applies to a failed API fetch).
const KNOWN_ROOT_IDS: Record<FolderRootSymbol, readonly string[]> = {
  toolbar: ['toolbar_____', '1'],
  menu: ['menu________'],
  other: ['unfiled_____', '2'],
};

export interface FolderRootMatch {
  id: string;
  title: string;
}

export function resolveFolderRoots(
  tree: Browser.bookmarks.BookmarkTreeNode[],
): Record<FolderRootSymbol, FolderRootMatch | null> {
  const roots = tree[0]?.children ?? [];
  const result: Record<FolderRootSymbol, FolderRootMatch | null> = {
    toolbar: null,
    menu: null,
    other: null,
  };

  for (const node of roots) {
    let symbol: FolderRootSymbol | null = null;
    if (node.folderType === 'bookmarks-bar') symbol = 'toolbar';
    else if (node.folderType === 'other') symbol = 'other';
    else if (node.folderType === undefined) {
      symbol =
        (Object.keys(KNOWN_ROOT_IDS) as FolderRootSymbol[]).find((candidate) =>
          KNOWN_ROOT_IDS[candidate].includes(node.id),
        ) ?? null;
    }
    if (symbol && result[symbol] === null) {
      result[symbol] = { id: node.id, title: node.title };
    }
  }

  return result;
}

export function resolveFolderRootId(
  tree: Browser.bookmarks.BookmarkTreeNode[],
  symbol: FolderRootSymbol,
): string | null {
  return resolveFolderRoots(tree)[symbol]?.id ?? null;
}
