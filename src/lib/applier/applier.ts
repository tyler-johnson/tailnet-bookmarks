// The applier. DESIGN.md "Components": "Executes ops against
// `browser.bookmarks`. Thin, no decisions." Every decision — what to
// create, update, or remove, and when a removal is even allowed — was
// already made by the planner (src/lib/planner, closed to this flight).
// This module's only job is turning an `Op[]` into `browser.bookmarks`
// calls and counting what actually happened.
//
// `BookmarksAPI` is the minimal slice of `browser.bookmarks` this needs —
// structurally identical to the real API (see wxt/browser's
// `Browser.bookmarks` namespace), so the real thing can be passed in
// directly with no adapter, the same seam pattern as
// `src/lib/tailscale/session-store.ts`'s `SessionKV`. Tests substitute an
// in-memory fake instead of needing a browser/WXT runtime.

import type { Op } from '../planner';
import type { Browser } from 'wxt/browser';

export interface BookmarksAPI {
  getTree(): Promise<Browser.bookmarks.BookmarkTreeNode[]>;
  getChildren(id: string): Promise<Browser.bookmarks.BookmarkTreeNode[]>;
  create(bookmark: { parentId: string; title: string; url?: string }): Promise<Browser.bookmarks.BookmarkTreeNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<Browser.bookmarks.BookmarkTreeNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}

export interface ApplierContext {
  bookmarks: BookmarksAPI;
  /** Where a `createFolder` op, if present, creates the managed folder. */
  parentId: string;
  /** The managed folder's derived name (DESIGN.md "Convergent identity"
   * — never configuration, never a cached value). Used only if `ops`
   * contains a `createFolder` op. */
  folderName: string;
  /**
   * The id of the single surviving candidate folder that ops other than
   * `createFolder` implicitly target. Undefined exactly when `ops`
   * contains a `createFolder` op — the planner never emits both in the
   * same result (planner.ts rule 4a: it creates when the caller passed
   * zero candidate folders, or picks a survivor and emits
   * `removeDuplicateFolder` for the rest when the caller passed one or
   * more). The caller (src/lib/background/run.ts) derives this from
   * `actualFolders` and the planner's own op list — see its doc comment
   * — never by re-deciding which folder should survive.
   */
  folderId?: string;
}

export interface ApplyResult {
  created: number;
  updated: number;
  removed: number;
}

/**
 * Executes `ops` against `ctx.bookmarks`, in a fixed order grouped by op
 * *kind* — never the order `ops` happens to list them in, since rule 1
 * (planner.ts) already guarantees nothing depends on ordering between
 * different URLs, and grouping by kind is what makes the folder-existence
 * dependency between kinds explicit:
 *
 *   1. `createFolder`   — at most one; creates the managed folder under
 *                          `ctx.parentId` and becomes the target for
 *                          every op below. Must run first: nothing else
 *                          has anywhere to write until this exists.
 *   2. `removeDuplicateFolder` — deletes losing candidate folders
 *                          (recursively — `removeTree`, since a loser can
 *                          hold bookmarks). Runs before any bookmark-level
 *                          op so a folder that's about to disappear can't
 *                          be mistaken for the target.
 *   3. `removeBookmark` — every removal the planner emitted, whether it
 *                          is rule 4's duplicate-URL cleanup or rule 5's
 *                          lagged delete; the `Op` type doesn't (and
 *                          doesn't need to) distinguish the two, and
 *                          removing before creating keeps the folder's
 *                          transient content monotonically closer to
 *                          `desired` rather than growing then shrinking.
 *   4. `createBookmark` — additive work: URLs `desired` wants that
 *                          nothing surviving currently has.
 *   5. `updateTitle`    — corrective work on survivors whose title
 *                          drifted. Runs last; its target set is disjoint
 *                          from every `createBookmark` target by
 *                          construction (planner.ts only emits one or the
 *                          other per URL), so the order relative to step
 *                          4 doesn't matter functionally — this is just a
 *                          single fixed, stated order rather than an
 *                          implicit one.
 *
 * ## When an op's target is already gone
 *
 * Every op below targets an id read from a `getChildren` snapshot taken
 * moments earlier in this same run (src/lib/background/run.ts). The one
 * realistic way an id-targeted op (`removeDuplicateFolder`,
 * `removeBookmark`, `updateTitle`) can fail between that snapshot and
 * this call is a sync-driven change landing from another machine that
 * reached the same conclusion first and already removed or altered the
 * node — exactly the concurrent-writers scenario DESIGN.md's "Sync and
 * convergence" exists for. The WebExtension bookmarks API gives no typed
 * "not found" distinct from any other failure, so this applier does not
 * try to tell them apart: **any** failure on an id-targeted op is caught,
 * not rethrown, not retried, and not counted in the returned totals — the
 * goal state (gone, or renamed) is either already achieved by the other
 * machine or will be re-evaluated fresh on the very next run (the
 * planner recomputes `actualFolders` from scratch every time; nothing
 * here is assumed to have succeeded). This is the one policy this module
 * has, stated once, not a per-op judgment call — consistent with "thin,
 * no decisions": it does not decide whether a target *should* still
 * exist, only that it no longer needs to act on one that doesn't.
 *
 * `createFolder` and `createBookmark` are not id-targeted (they don't
 * reference an existing node) and are not caught here: a failure there
 * is a real inability to reconcile this run and propagates so the caller
 * records it as a failed run, per DESIGN.md "Badge surfaces failure
 * state."
 */
export async function applyOps(ops: readonly Op[], ctx: ApplierContext): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, removed: 0 };
  let folderId = ctx.folderId;

  for (const op of byKind(ops, 'createFolder')) {
    const created = await ctx.bookmarks.create({ parentId: ctx.parentId, title: ctx.folderName });
    folderId = created.id;
    void op; // at most one createFolder op; nothing on it beyond its type
  }

  for (const op of byKind(ops, 'removeDuplicateFolder')) {
    if (await tryIdOp(() => ctx.bookmarks.removeTree(op.folderId))) result.removed++;
  }

  for (const op of byKind(ops, 'removeBookmark')) {
    if (await tryIdOp(() => ctx.bookmarks.remove(op.id))) result.removed++;
  }

  for (const op of byKind(ops, 'createBookmark')) {
    if (folderId === undefined) {
      throw new Error(
        'applyOps: createBookmark op with no target folder — the planner emitted a create without a ' +
          'createFolder op and no existing folder id was supplied; this is a caller bug, not a race',
      );
    }
    await ctx.bookmarks.create({ parentId: folderId, title: op.title, url: op.url });
    result.created++;
  }

  for (const op of byKind(ops, 'updateTitle')) {
    if (await tryIdOp(() => ctx.bookmarks.update(op.id, { title: op.title }))) result.updated++;
  }

  return result;
}

function byKind<T extends Op['type']>(ops: readonly Op[], type: T): Extract<Op, { type: T }>[] {
  return ops.filter((op): op is Extract<Op, { type: T }> => op.type === type);
}

/** Runs an id-targeted mutation, swallowing any failure — see the
 * "When an op's target is already gone" section of `applyOps`'s doc
 * comment. Returns whether it completed. */
async function tryIdOp(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}
