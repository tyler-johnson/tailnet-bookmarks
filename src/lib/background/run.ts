// The reconcile run itself (DESIGN.md "Approach" flowchart, from "locate
// folder by derived name" down through "plan(desired, actual) -> ops").
// Everything above that line in the flowchart (config present?, the
// settle delay, the alarm vs. manual trigger) is orchestration that also
// has to touch `browser.alarms`, `browser.permissions`, and `storage`
// directly — see src/entrypoints/background.ts, the thin wrapper around
// this. This module stays testable without a browser: every browser-ish
// dependency is injected (`BookmarksAPI`, `TokenStore`, `fetchImpl`), the
// same seam pattern `src/lib/tailscale` already uses.
//
// No decisions live here beyond "can this run's folder-locating even
// start" (`no-parent`) and "should this run do anything at all"
// (`aborted`, when the desired set itself is unknown). Which bookmarks to
// create, update, or remove is entirely `plan`'s (src/lib/planner,
// closed); actually creating, updating, or removing them is entirely
// `applyOps`'s (src/lib/applier).

import { buildDesiredSet, type SourceToggles } from '../desired-set';
import { plan, type ActualBookmark, type ActualFolder, type FirstMissingAt, type Op } from '../planner';
import { applyOps, type BookmarksAPI } from '../applier';
import { fetchTailnetData, type TailscaleCredentials, type TokenStore } from '../tailscale';
import { resolveFolderRootId, type FolderRootSymbol } from '../storage';

export interface RunInputs {
  /** Present and non-empty — the caller (background.ts) checks
   * config/permission and declines to call this at all otherwise, per
   * the manual-sync contract's "can't start" cases. */
  credentials: TailscaleCredentials;
  toggles: SourceToggles;
  folderParentSymbol: FolderRootSymbol;
  /** This machine's persisted delete-lag bookkeeping (`storage.local`,
   * `local:firstMissingAt`) going into this run. */
  firstMissingAt: FirstMissingAt;
  now: number;
  /** From the configured poll interval — DESIGN.md "Lagged deletes"
   * wants removal confirmed "on two consecutive polls at least one
   * interval apart"; see src/lib/background/status.ts's
   * `deleteLagMsFromPollInterval`. */
  deleteLagMs: number;
  bookmarks: BookmarksAPI;
  tokenStore: TokenStore;
  /** Injectable for tests; defaults to `fetch` inside
   * `fetchTailnetData` when omitted. */
  fetchImpl?: typeof fetch;
}

export type RunOutcome =
  | {
      /** DESIGN.md "Convergent identity": the parent is resolved fresh,
       * by symbol, every run — never trusted from a cached id. When it
       * doesn't resolve on this machine (e.g. `'menu'` on a Chromium
       * profile — see storage.ts's `resolveFolderRoots`), there is
       * nothing to locate the managed folder under, so this run does
       * nothing rather than guess. */
      status: 'no-parent';
      folderParentSymbol: FolderRootSymbol;
    }
  | {
      /** DESIGN.md flowchart: "every slice unknown -> abort, keep
       * folder". In practice this fires exactly when the devices slice
       * is unknown — `buildDesiredSet` forces the whole result unknown
       * then, since the tailnet suffix (and therefore the folder name)
       * derives from it. `firstMissingAt` passes through completely
       * unchanged, matching `plan`'s own "do nothing whatsoever" rule
       * for this case. */
      status: 'aborted';
      reason: string;
      firstMissingAt: Record<string, number>;
    }
  | {
      status: 'ok';
      created: number;
      updated: number;
      removed: number;
      firstMissingAt: Record<string, number>;
    };

export async function runReconcile(inputs: RunInputs): Promise<RunOutcome> {
  const tree = await inputs.bookmarks.getTree();
  const parentId = resolveFolderRootId(tree, inputs.folderParentSymbol);
  if (parentId === null) {
    return { status: 'no-parent', folderParentSymbol: inputs.folderParentSymbol };
  }

  const data = await fetchTailnetData(inputs.credentials, inputs.tokenStore, {
    fetchImpl: inputs.fetchImpl,
    now: () => inputs.now,
  });
  const desired = buildDesiredSet(data, inputs.toggles);

  if (desired.status === 'unknown') {
    return { status: 'aborted', reason: desired.reason, firstMissingAt: { ...inputs.firstMissingAt } };
  }

  // Located by name on every run, never by a cached id — DESIGN.md
  // "Convergent identity": a machine's local id for a synced folder
  // isn't the id another machine cached, so trusting one is how a
  // second folder gets created.
  const folderName = desired.tailnetSuffix;
  const candidates = await locateCandidateFolders(inputs.bookmarks, parentId, folderName);

  const { ops, firstMissingAt } = plan(desired, candidates, inputs.firstMissingAt, inputs.now, inputs.deleteLagMs);

  const { created, updated, removed } = await applyOps(ops, {
    bookmarks: inputs.bookmarks,
    parentId,
    folderName,
    folderId: survivingFolderId(candidates, ops),
  });

  return { status: 'ok', created, updated, removed, firstMissingAt };
}

/** Reads the candidate managed folders under `parentId` — every
 * top-level child whose title matches the derived `folderName` — and
 * their bookmark contents, in the shape `plan` wants. A sub-folder
 * inside a candidate is neither included in `bookmarks` here nor ever
 * passed to `applyOps`, so it's left alone, per DESIGN.md "Known
 * limits": "Nested folders are left alone as an escape hatch." */
async function locateCandidateFolders(
  bookmarks: BookmarksAPI,
  parentId: string,
  folderName: string,
): Promise<ActualFolder[]> {
  const children = await bookmarks.getChildren(parentId);
  const matches = children.filter((node) => node.url === undefined && node.title === folderName);

  const folders: ActualFolder[] = [];
  for (const match of matches) {
    const kids = await bookmarks.getChildren(match.id);
    const bookmarksInFolder: ActualBookmark[] = kids
      .filter((node) => node.url !== undefined)
      .map((node) => ({
        id: node.id,
        url: node.url!,
        title: node.title,
        dateAdded: node.dateAdded ?? 0,
      }));
    folders.push({ id: match.id, dateAdded: match.dateAdded ?? 0, bookmarks: bookmarksInFolder });
  }
  return folders;
}

/**
 * The id of the one candidate folder that ops other than `createFolder`
 * implicitly target — i.e. whichever candidate the planner's
 * `removeDuplicateFolder` ops do *not* name. This is a mechanical read of
 * the planner's own output, not a re-decision of which folder survives:
 * `plan` already picked the survivor (planner.ts rule 4a) when it chose
 * which candidates to emit `removeDuplicateFolder` for; this just asks
 * "which one did it leave alone." Returns `undefined` when `ops`
 * contains a `createFolder` op instead (zero candidates going in), which
 * is exactly when `applyOps` needs it to be undefined.
 */
function survivingFolderId(candidates: readonly ActualFolder[], ops: readonly Op[]): string | undefined {
  const removedIds = new Set(
    ops
      .filter((op): op is Extract<Op, { type: 'removeDuplicateFolder' }> => op.type === 'removeDuplicateFolder')
      .map((op) => op.folderId),
  );
  return candidates.find((c) => !removedIds.has(c.id))?.id;
}
