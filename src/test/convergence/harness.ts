// Flight #5 — test-only convergence harness. Not consumed by any
// entrypoint, not exported from `src/lib/*`, and not itself part of the
// shipped extension. Its only job is to make DESIGN.md's central claim
// checkable: "a harness that simulates two browsers and a sync channel
// between them can assert the op stream goes empty and stays empty."
//
// Not touched, and not this flight's to touch: src/lib/planner/*,
// src/lib/desired-set/*, src/lib/tailscale/*, src/lib/applier* (flight
// #6, in another worktree right now), src/entrypoints/*.
//
// ---------------------------------------------------------------------
// The model — two ids per node, on purpose
// ---------------------------------------------------------------------
//
// DESIGN.md "Independent creation": "Sync merges bookmarks by identity,
// not by URL... a machine's local bookmark id for the synced folder is
// not the id another machine cached." This harness takes that literally:
// every folder and bookmark node has TWO distinct ids.
//
//   - `syncId`  — the cross-browser identity. Minted once, at the
//     moment a node is first created by SOME browser, and carried
//     verbatim across the sync channel to every browser that later
//     learns of it. Two nodes independently created for the same URL
//     get two different `syncId`s and remain two distinct nodes through
//     the merge — this is the whole reason duplicates are possible, and
//     a harness that merged by URL instead would never be able to
//     reproduce that.
//
//   - local `id` — the `id` field on `ActualBookmark`/`ActualFolder`
//     that `plan()` actually sees, and that its `Op`s reference
//     (`updateTitle.id`, `removeBookmark.id`, `removeDuplicateFolder.
//     folderId`). Minted independently by EACH browser the first time
//     *that browser* learns of a `syncId` — its own creation, or a
//     delivery off the sync channel. Never sent over the channel,
//     never shared. This is what makes it true, by construction, that
//     one browser's local id for a node is meaningless to another.
//
// `dateAdded` is real synced data (in the real extension as much as in
// this model), so it travels with a node unchanged. That is what lets
// rule 4's oldest-`dateAdded` tie-break pick the same survivor on every
// machine with no coordination — see `resolveTargetFolder` below, which
// depends on it.

import { plan } from '../../lib/planner';
import type { ActualBookmark, ActualFolder, FirstMissingAt, Op } from '../../lib/planner';
import type { DesiredSet } from '../../lib/desired-set';

let idCounter = 0;
/** Fresh, globally-unique string id. Used for both local ids and
 * syncIds — the two spaces never need to be told apart by value, only
 * by which map they're looked up through, so one counter is enough. */
function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// ---------------------------------------------------------------------
// Local model state — one browser's own view
// ---------------------------------------------------------------------

export interface LocalBookmark {
  localId: string;
  syncId: string;
  url: string;
  title: string;
  dateAdded: number;
}

export interface LocalFolder {
  localId: string;
  syncId: string;
  dateAdded: number;
  bookmarks: LocalBookmark[];
}

export interface SimulatedBrowser {
  readonly name: string;
  folders: LocalFolder[];
  firstMissingAt: FirstMissingAt;
}

function findFolderBySyncId(browser: SimulatedBrowser, syncId: string): LocalFolder | undefined {
  return browser.folders.find((f) => f.syncId === syncId);
}

function findBookmarkBySyncId(browser: SimulatedBrowser, syncId: string): LocalBookmark | undefined {
  for (const folder of browser.folders) {
    const found = folder.bookmarks.find((b) => b.syncId === syncId);
    if (found) return found;
  }
  return undefined;
}

function findLocalBookmarkById(browser: SimulatedBrowser, localId: string): LocalBookmark | undefined {
  for (const folder of browser.folders) {
    const found = folder.bookmarks.find((b) => b.localId === localId);
    if (found) return found;
  }
  return undefined;
}

function findLocalBookmarkOwner(browser: SimulatedBrowser, localId: string): LocalFolder | undefined {
  return browser.folders.find((f) => f.bookmarks.some((b) => b.localId === localId));
}

/** `plan()`'s view of a browser's current state: the `ActualFolder[]`
 * it must be called with this round. Pure projection, no mutation. */
export function materialize(browser: SimulatedBrowser): ActualFolder[] {
  return browser.folders.map((f) => ({
    id: f.localId,
    dateAdded: f.dateAdded,
    bookmarks: f.bookmarks.map((b) => ({ id: b.localId, url: b.url, title: b.title, dateAdded: b.dateAdded })),
  }));
}

// ---------------------------------------------------------------------
// The sync channel — events, not snapshots
// ---------------------------------------------------------------------
//
// A change a browser makes (locally, whether via `plan()`'s ops or via
// this harness's own seeding helpers below) is queued as a small event
// keyed on `syncId`, and delivered to every OTHER browser no sooner
// than `deliveryDelayTicks` polls later — never in the same round a
// change is made, because real sync is never instant within one poll.
// This is deliberately event-sourced rather than snapshot-diffed: it is
// the most direct way to guarantee the channel merges by `syncId` and
// never by `url`, since a `SyncEvent` never carries enough information
// to be matched any other way (a `create` event's `url` is payload, not
// identity — two `bookmark-create` events for the same `url` and
// different `syncId`s are, correctly, two separate deliveries that each
// mint their own new local node on the receiving side).

type SyncEvent =
  | { kind: 'folder'; op: 'create'; syncId: string; dateAdded: number }
  | { kind: 'folder'; op: 'remove'; syncId: string }
  | { kind: 'bookmark'; op: 'create'; syncId: string; folderSyncId: string; url: string; title: string; dateAdded: number }
  | { kind: 'bookmark'; op: 'updateTitle'; syncId: string; title: string }
  | { kind: 'bookmark'; op: 'remove'; syncId: string };

function folderCreateEvent(folder: LocalFolder): SyncEvent {
  return { kind: 'folder', op: 'create', syncId: folder.syncId, dateAdded: folder.dateAdded };
}

function bookmarkCreateEvent(bookmark: LocalBookmark, folderSyncId: string): SyncEvent {
  return { kind: 'bookmark', op: 'create', syncId: bookmark.syncId, folderSyncId, url: bookmark.url, title: bookmark.title, dateAdded: bookmark.dateAdded };
}

interface PendingDelivery {
  deliverAtTick: number;
  from: string;
  events: SyncEvent[];
}

class SyncChannel {
  private pending: PendingDelivery[] = [];

  publish(from: string, events: SyncEvent[], deliverAtTick: number): void {
    if (events.length === 0) return;
    this.pending.push({ deliverAtTick, from, events });
  }

  /** Applies every delivery whose `deliverAtTick` has arrived, to every
   * browser except its sender, then drops it from the queue. Deliveries
   * for a later tick are left queued — this is what models "late
   * delivery" when a caller passes a `deliveryDelayTicks` above the
   * default of 1. */
  deliverDue(tick: number, browsers: ReadonlyMap<string, SimulatedBrowser>): void {
    const due = this.pending.filter((p) => p.deliverAtTick <= tick);
    if (due.length === 0) return;
    this.pending = this.pending.filter((p) => p.deliverAtTick > tick);
    for (const delivery of due) {
      for (const [name, browser] of browsers) {
        if (name === delivery.from) continue; // a browser never "receives" its own writes over the channel — applyOps already applied them locally, immediately
        for (const event of delivery.events) applyEvent(browser, event);
      }
    }
  }
}

/** Applies one delivered `SyncEvent` to a receiving browser's local
 * state. Idempotent by `syncId` in both directions (a duplicate
 * delivery, or a delivery this browser already knows about via some
 * other path, is a no-op rather than a double-apply). A `bookmark`
 * `create` whose `folderSyncId` isn't known locally yet is dropped
 * rather than throwing — this harness's own event batches always
 * deliver a folder's `create` before any of its children's events (see
 * `applyOps` below), so that never fires from this harness's own
 * scenarios, but a delivery reordered by a longer delay elsewhere
 * should degrade safely rather than crash the simulation. */
function applyEvent(browser: SimulatedBrowser, event: SyncEvent): void {
  if (event.kind === 'folder') {
    if (event.op === 'create') {
      if (findFolderBySyncId(browser, event.syncId)) return;
      browser.folders.push({ localId: freshId(`${browser.name}:folder`), syncId: event.syncId, dateAdded: event.dateAdded, bookmarks: [] });
    } else {
      // Cascades: removing the folder drops whatever bookmarks this
      // browser had filed under it too, exactly like a real
      // `bookmarks.removeTree` and its own propagation over sync.
      browser.folders = browser.folders.filter((f) => f.syncId !== event.syncId);
    }
    return;
  }

  if (event.op === 'create') {
    if (findBookmarkBySyncId(browser, event.syncId)) return;
    const folder = findFolderBySyncId(browser, event.folderSyncId);
    if (!folder) return;
    folder.bookmarks.push({ localId: freshId(`${browser.name}:bookmark`), syncId: event.syncId, url: event.url, title: event.title, dateAdded: event.dateAdded });
  } else if (event.op === 'updateTitle') {
    const bookmark = findBookmarkBySyncId(browser, event.syncId);
    if (bookmark) bookmark.title = event.title;
  } else {
    for (const folder of browser.folders) folder.bookmarks = folder.bookmarks.filter((b) => b.syncId !== event.syncId);
  }
}

// ---------------------------------------------------------------------
// The model applier — the behavioral spec flight #6 must match
// ---------------------------------------------------------------------
//
// `plan()`'s `Op[]` never carries a folder id on any bookmark-level op
// (`createBookmark`, `updateTitle`, `removeBookmark`) — DESIGN.md rule 1
// plus planner.ts's own doc comment: "the planner deals with exactly
// one target folder per run, so no op needs to carry a parent/folder id
// of its own." That means BOTH this harness's model applier and flight
// #6's real `browser.bookmarks` applier must independently re-derive
// which folder is "the" target the exact same way `plan()` did
// internally, from the very same `actualFolders` the planner was just
// called with:
//
//   - if this run's `ops` contains a `createFolder`, the target is the
//     folder that op just created (there were previously zero).
//   - otherwise, the target is the survivor `plan()` itself would have
//     picked among `actualFolders`: sort by `dateAdded` ascending, tie-
//     break by `id` ascending — byte-for-byte the same comparator as
//     planner.ts's private `compareFoldersForSurvivor`, which is not
//     exported (rule 1's spirit: nothing outside the planner should
//     need folder identity as a concept), so this is a deliberate,
//     literal re-implementation rather than an import. If planner.ts's
//     tie-break ever changes, this must change with it.
//
// `createBookmark`, `updateTitle`, and `removeBookmark` then apply
// against that one resolved target folder: a create appends a brand
// new node (fresh local id, fresh syncId, `dateAdded = now`); an update
// or removal look up the existing local node by the op's local `id` —
// never by `url`, and never by `syncId`, both of which the op does not
// carry and the applier has no business needing.
//
// `removeDuplicateFolder` and the `removeBookmark`s rule 4b emits for
// in-folder URL duplicates are applied by local id exactly the same
// way. Every mutation this function makes also produces the matching
// `SyncEvent`(s) for `publish` to hand to the sync channel — that part
// is specific to this harness (a real applier hands the browser's own
// `bookmarks` API, and lets the browser's real sync engine do the
// propagating), but the *local* mutation semantics above are exactly
// what flight #6's applier must reproduce against `browser.bookmarks`.
export function applyOps(browser: SimulatedBrowser, actualFoldersSnapshot: readonly ActualFolder[], ops: readonly Op[], now: number): SyncEvent[] {
  const events: SyncEvent[] = [];
  let targetFolder = resolveExistingTargetFolder(browser, actualFoldersSnapshot);

  for (const op of ops) {
    switch (op.type) {
      case 'createFolder': {
        const created: LocalFolder = { localId: freshId(`${browser.name}:folder`), syncId: freshId('folder'), dateAdded: now, bookmarks: [] };
        browser.folders.push(created);
        targetFolder = created;
        events.push(folderCreateEvent(created));
        break;
      }
      case 'removeDuplicateFolder': {
        const idx = browser.folders.findIndex((f) => f.localId === op.folderId);
        if (idx === -1) throw new Error(`model applier: removeDuplicateFolder for unknown local folder id "${op.folderId}"`);
        const [removed] = browser.folders.splice(idx, 1);
        events.push({ kind: 'folder', op: 'remove', syncId: removed!.syncId });
        break;
      }
      case 'createBookmark': {
        if (!targetFolder) throw new Error('model applier: createBookmark with no resolvable target folder');
        const created: LocalBookmark = { localId: freshId(`${browser.name}:bookmark`), syncId: freshId('bookmark'), url: op.url, title: op.title, dateAdded: now };
        targetFolder.bookmarks.push(created);
        events.push(bookmarkCreateEvent(created, targetFolder.syncId));
        break;
      }
      case 'updateTitle': {
        const bookmark = findLocalBookmarkById(browser, op.id);
        if (!bookmark) throw new Error(`model applier: updateTitle for unknown local bookmark id "${op.id}"`);
        bookmark.title = op.title;
        events.push({ kind: 'bookmark', op: 'updateTitle', syncId: bookmark.syncId, title: bookmark.title });
        break;
      }
      case 'removeBookmark': {
        const owner = findLocalBookmarkOwner(browser, op.id);
        if (!owner) throw new Error(`model applier: removeBookmark for unknown local bookmark id "${op.id}"`);
        const [removed] = owner.bookmarks.filter((b) => b.localId === op.id);
        owner.bookmarks = owner.bookmarks.filter((b) => b.localId !== op.id);
        events.push({ kind: 'bookmark', op: 'remove', syncId: removed!.syncId });
        break;
      }
    }
  }

  return events;
}

/** Re-derives `plan()`'s internal `chosenFolder` from the snapshot it
 * was actually called with. `undefined` when `actualFoldersSnapshot` is
 * empty — in that case a `createFolder` op is guaranteed to be present
 * in `ops` (that is precisely when `plan()` emits one) and `applyOps`'s
 * loop above sets `targetFolder` from it directly. */
function resolveExistingTargetFolder(browser: SimulatedBrowser, actualFoldersSnapshot: readonly ActualFolder[]): LocalFolder | undefined {
  if (actualFoldersSnapshot.length === 0) return undefined;
  const survivorId = [...actualFoldersSnapshot].sort((a, b) => a.dateAdded - b.dateAdded || a.id.localeCompare(b.id))[0]!.id;
  return browser.folders.find((f) => f.localId === survivorId);
}

// ---------------------------------------------------------------------
// World — N simulated browsers sharing one sync channel
// ---------------------------------------------------------------------

export interface World {
  readonly browsers: Map<string, SimulatedBrowser>;
  readonly channel: SyncChannel;
  tick: number;
}

export function createWorld(names: readonly string[]): World {
  const browsers = new Map<string, SimulatedBrowser>();
  for (const name of names) browsers.set(name, { name, folders: [], firstMissingAt: {} });
  return { browsers, channel: new SyncChannel(), tick: 0 };
}

export interface PollOptions {
  /** A single shared instant, or a function of the browser name for a
   * per-browser clock. Prefer the function form whenever more than one
   * browser in the world can independently create the same node in the
   * same round (i.e. most multi-browser scenarios) — see the note
   * below on why a single shared `now` is not a safe default there. */
  now: number | ((browserName: string) => number);
  deleteLagMs: number;
  /** Same `DesiredSet` for every browser (the common case: one tailnet,
   * every machine's OAuth client reads the same API and agrees — see
   * DESIGN.md "Auth"), or a function of the browser name for a test
   * that deliberately wants machines to disagree about what's desired. */
  desired: DesiredSet | ((browserName: string) => DesiredSet);
  /** Ticks after this poll before a browser's writes become visible to
   * every OTHER browser. Defaults to 1 — sync is never instant within
   * the same poll a change was made in. A larger value models DESIGN.md
   * "Late delivery". */
  deliveryDelayTicks?: number;
}

/** Runs one poll across every browser in `world`: delivers whatever the
 * sync channel owes this tick, then calls `plan()` + the model applier
 * for each browser in turn against its own (now possibly just-updated)
 * local state, and finally queues each browser's own changes for
 * future delivery to the others. Returns each browser's `ops` this
 * round, keyed by name, for assertions.
 *
 * ## Why `now` should usually differ per browser
 *
 * `now` becomes `dateAdded` on anything a browser creates this round
 * (see `applyOps`). If two browsers independently create a node for
 * the same URL in the SAME round (DESIGN.md's "Two writers" /
 * "Independent creation" hazards — genuinely possible, and exactly
 * what this harness exists to exercise), rule 4's tie-break is
 * `dateAdded` first, and only reaches its `id`/local-id fallback when
 * `dateAdded` ties too. A shared `now` across browsers manufactures
 * that tie artificially, every single time it recurs, which is not
 * realistic: two real machines' `Date.now()` at the moment of an
 * actual `browser.bookmarks.create()` call are never bit-identical.
 * Under a genuinely shared clock, the `id` fallback can pick DIFFERENT
 * survivors on each side (a real risk, since local ids are never
 * synced by construction — see the id doc comment up top); the two
 * sides then each delete what the OTHER side just kept, those deletes
 * cross-deliver, both survivors vanish, and both sides recreate the
 * node next round with a FRESH but again-tied `dateAdded` — repeating
 * forever rather than the "bounded, one extra cycle" self-correction
 * planner.ts's own doc comment describes for this fallback. That
 * self-correction argument depends on the recreate breaking the tie,
 * which only holds if `now` genuinely differs machine to machine. Pass
 * a per-browser `now` function to reflect that; see convergence.test.ts
 * for the scenarios that need it and the one that deliberately proved
 * this before the fix. */
export function runPoll(world: World, options: PollOptions): Record<string, Op[]> {
  world.tick += 1;
  const tick = world.tick;
  world.channel.deliverDue(tick, world.browsers);

  const opsByBrowser: Record<string, Op[]> = {};
  for (const [name, browser] of world.browsers) {
    const now = typeof options.now === 'function' ? options.now(name) : options.now;
    const desired = typeof options.desired === 'function' ? options.desired(name) : options.desired;
    const actualFolders = materialize(browser);
    const result = plan(desired, actualFolders, browser.firstMissingAt, now, options.deleteLagMs);
    browser.firstMissingAt = result.firstMissingAt;
    const events = applyOps(browser, actualFolders, result.ops, now);
    world.channel.publish(name, events, tick + (options.deliveryDelayTicks ?? 1));
    opsByBrowser[name] = result.ops;
  }
  return opsByBrowser;
}

// ---------------------------------------------------------------------
// Seeding helpers — constructing a starting divergence directly
// ---------------------------------------------------------------------
//
// These bypass `plan()`/`applyOps` to set up a scenario's initial state
// (what a browser already holds before the simulation window starts),
// as opposed to state produced by the simulation itself. Any node
// seeded is real content that must behave exactly like anything else in
// this model: `seedLocalFolder`/`seedBookmark` publish the same
// `SyncEvent`s a live create would, so pre-existing content genuinely
// reaches every other browser through the channel on its own schedule
// — a starting divergence must still converge to ONE identity per node,
// not silently stay forked because seeding skipped the channel.

/** Creates a new folder local to one browser only, and (by default)
 * publishes its creation so every other browser eventually learns of
 * it too, at `world.tick + deliveryDelayTicks`. Pass `publish: false`
 * only for a scenario that deliberately wants the other browser(s) to
 * never learn of this folder through the channel. */
export function seedLocalFolder(world: World, browserName: string, dateAdded: number, opts: { publish?: boolean; deliveryDelayTicks?: number } = {}): LocalFolder {
  const browser = world.browsers.get(browserName);
  if (!browser) throw new Error(`seedLocalFolder: no browser named "${browserName}"`);
  const folder: LocalFolder = { localId: freshId(`${browserName}:folder`), syncId: freshId('folder'), dateAdded, bookmarks: [] };
  browser.folders.push(folder);
  if (opts.publish !== false) {
    world.channel.publish(browserName, [folderCreateEvent(folder)], world.tick + (opts.deliveryDelayTicks ?? 1));
  }
  return folder;
}

/** Creates a folder with the SAME `syncId` directly in every named
 * browser, with no publish at all — a baseline the scenario asserts is
 * already fully agreed (e.g. "both browsers already converged on one
 * folder before this test's window begins"), as opposed to something
 * that needs to sync into agreement during the run. */
export function seedSharedFolder(world: World, browserNames: readonly string[], dateAdded: number): { syncId: string; foldersByBrowser: Map<string, LocalFolder> } {
  const syncId = freshId('folder');
  const foldersByBrowser = new Map<string, LocalFolder>();
  for (const name of browserNames) {
    const browser = world.browsers.get(name);
    if (!browser) throw new Error(`seedSharedFolder: no browser named "${name}"`);
    const folder: LocalFolder = { localId: freshId(`${name}:folder`), syncId, dateAdded, bookmarks: [] };
    browser.folders.push(folder);
    foldersByBrowser.set(name, folder);
  }
  return { syncId, foldersByBrowser };
}

/** Adds a bookmark directly to `folder` (which must already be attached
 * to `browserName`'s state — from `seedLocalFolder` or
 * `seedSharedFolder`), and (by default) publishes its creation the same
 * way `seedLocalFolder` does. */
export function seedBookmark(
  world: World,
  browserName: string,
  folder: LocalFolder,
  params: { url: string; title: string; dateAdded: number },
  opts: { publish?: boolean; deliveryDelayTicks?: number } = {},
): LocalBookmark {
  const browser = world.browsers.get(browserName);
  if (!browser) throw new Error(`seedBookmark: no browser named "${browserName}"`);
  const bookmark: LocalBookmark = { localId: freshId(`${browserName}:bookmark`), syncId: freshId('bookmark'), url: params.url, title: params.title, dateAdded: params.dateAdded };
  folder.bookmarks.push(bookmark);
  if (opts.publish !== false) {
    world.channel.publish(browserName, [bookmarkCreateEvent(bookmark, folder.syncId)], world.tick + (opts.deliveryDelayTicks ?? 1));
  }
  return bookmark;
}
