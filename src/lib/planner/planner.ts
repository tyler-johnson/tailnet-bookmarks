// The planner. DESIGN.md "Components": `plan(desired, actual) -> Op[]`,
// pure, no browser API, no I/O — the whole of the five convergence
// rules in DESIGN.md "Sync and convergence" lives here and nowhere
// else. Consumes `DesiredSet` from `../desired-set` (flight #3, closed)
// and a caller-supplied snapshot of what the managed folder(s) actually
// contain; produces an `Op[]` for the applier (flight #6, not this
// flight) to execute, plus the updated delete-lag bookkeeping.
//
// Pure. No browser API, no `fetch`, no `Date.now()` — `now` is always a
// parameter, never read from the environment. Runs under vitest with no
// WXT runtime.

import type { DesiredBookmark, DesiredSet } from '../desired-set';

// ---------------------------------------------------------------------
// Op — rule 1: key on URL, never emit an index or ordering op
// ---------------------------------------------------------------------
//
// DESIGN.md "Minimal writes": "Index and ordering are never written;
// they are pure flap with nothing to show for it." The cheapest
// possible enforcement of that isn't a runtime check, it's making the
// op impossible to construct: no variant below carries an `index`,
// `position`, or sibling-order field, so there is no value of type `Op`
// that could tell the applier to reorder anything. (See
// `planner.test.ts` for a compile-time proof this stays true.)
//
// All five kinds the brief names are here and no others. `createFolder`
// and `removeDuplicateFolder` operate on the managed folder itself;
// the three bookmark-level ops implicitly target "the" managed folder
// resolved by any `createFolder` op in the same batch (or the single
// surviving folder identified by `removeDuplicateFolder`/no folder-op
// at all) — the planner deals with exactly one target folder per run,
// so no op needs to carry a parent/folder id of its own.
export type Op =
  | { type: 'createFolder' }
  | { type: 'removeDuplicateFolder'; folderId: string }
  | { type: 'createBookmark'; url: string; title: string }
  | { type: 'updateTitle'; id: string; url: string; title: string }
  | { type: 'removeBookmark'; id: string; url: string };

// ---------------------------------------------------------------------
// Actual state — what the caller reports the folder(s) currently hold
// ---------------------------------------------------------------------

/** One bookmark node as it actually exists in a candidate managed
 * folder. Deliberately a narrower shape than `Browser.bookmarks.
 * BookmarkTreeNode` — the planner only ever reasons about url, title,
 * and dateAdded (the three fields DESIGN.md's rules key on), never
 * `index` (rule 1) and never a sub-folder (DESIGN.md "Known limits":
 * "Nested folders are left alone as an escape hatch" — a caller should
 * simply not include them here). Keeping this shape narrow, rather than
 * importing the ambient browser type, is also what keeps this module
 * genuinely runnable with no WXT runtime in scope. */
export interface ActualBookmark {
  id: string;
  url: string;
  title: string;
  dateAdded: number;
}

/** One candidate managed folder — a top-level node under the configured
 * parent whose name matches the derived folder name. Ordinarily there
 * is exactly one; DESIGN.md's "Independent creation" hazard is exactly
 * how a second one comes to exist (two machines create it concurrently
 * before either has synced), so the caller may legitimately pass zero,
 * one, or several. */
export interface ActualFolder {
  id: string;
  dateAdded: number;
  bookmarks: ActualBookmark[];
}

// ---------------------------------------------------------------------
// Delete-lag bookkeeping — rule 5
// ---------------------------------------------------------------------

/** `{url: firstMissingAt}` — DESIGN.md "Lagged deletes": when a URL that
 * should exist stops appearing in the desired set, the timestamp of the
 * poll that first noticed it, so a second poll at least `deleteLagMs`
 * later can confirm the absence before anything is removed. */
export type FirstMissingAt = Readonly<Record<string, number>>;

export interface PlanResult {
  ops: Op[];
  /** The `firstMissingAt` map to persist for next run. Always a fresh
   * object — see `plan`'s doc comment for exactly what is carried
   * forward, dropped, or added in each case. */
  firstMissingAt: Record<string, number>;
}

/**
 * Plans the ops needed to reconcile `actualFolders` toward `desired`.
 *
 * ## Rule 3 — content-hash short circuit
 *
 * Before planning anything, if there is exactly one candidate folder
 * with no duplicate URLs in it, and a hash of its (url, title) pairs
 * equals a hash of `desired`'s (url, title) pairs, this returns
 * `{ ops: [], firstMissingAt: {} }` immediately. Hash equality here
 * means exact set equality of (url, title) pairs, so nothing is
 * missing either — the returned map is empty on purpose, not merely
 * unchanged, per flight #3's note: sort the keys before hashing, and
 * hash only url and title, never id, dateAdded, or index, or the
 * short circuit stops matching on the very first sync-assigned id
 * that differs machine to machine.
 *
 * Zero or several candidate folders always falls through to full
 * planning, because folder-level structure (create or dedupe) needs
 * resolving regardless of content match; so does a single folder that
 * itself holds a duplicate URL, since that duplicate needs resolving
 * even when its content already matches `desired`.
 *
 * ## `desired.status === 'unknown'`
 *
 * Returns `{ ops: [], firstMissingAt: <unchanged> }` before looking at
 * `actualFolders` at all — per flight #3's note, this shape of
 * "unknown" means do nothing whatsoever this run, not even delete-lag
 * bookkeeping.
 *
 * ## Rule 4 — duplicates
 *
 * Duplicate managed folders (more than one entry in `actualFolders`)
 * and duplicate URLs within the chosen folder both resolve to the
 * survivor with the oldest `dateAdded`; see `pickFolderSurvivor` and
 * `pickBookmarkSurvivor` for the deterministic tie-break below that.
 * The *selection* of a survivor always happens (content planning needs
 * a single target folder and a single node per URL to diff against);
 * whether the *losers* actually get removed is gated by the same rule
 * that gates rule 5, below.
 *
 * ## Rule 4 (continued) / the per-flight ruling on unknown slices
 *
 * DESIGN.md "Per-source slices" leaves unresolved what an unknown
 * slice should mean for a bookmark that is simply absent from the
 * folder-vs-desired diff: a bookmark node carries no source tag, so a
 * URL present in the folder and missing from `desired` is genuinely
 * ambiguous when a slice is unknown — a retired device, or a service
 * this run simply couldn't see. Classifying it soundly needs a
 * persisted last-known-source map that nobody has specified. This
 * flight's ruling, coarser than DESIGN.md's per-slice wording on
 * purpose: **if any slice is unknown, this emits no delete of any
 * kind this run** — not the lagged bookmark removals rule 5 would
 * otherwise arm, and not the rule 4 duplicate cleanups either, even
 * though duplicate resolution doesn't itself consult `desired`. The
 * broader reading is deliberately chosen over threading the
 * distinction through: a duplicate that survives one extra poll while
 * a slice recovers costs nothing, and a single "no deletes this run"
 * flag is far easier to prove correct than two independently-gated
 * delete paths. Creates and title updates are unaffected — see
 * `deletesSuppressed` below.
 *
 * ## Rule 5 — lagged deletes
 *
 * `firstMissingAt` and `now` come in, and an updated map comes back
 * out alongside `ops`. For each survivor bookmark whose URL is not in
 * `desired.entries` (and only when deletes are not suppressed):
 *   - not previously tracked -> record `now` as its first-missing
 *     time; no op yet.
 *   - previously tracked, `now - firstMissingAt[url] < deleteLagMs` ->
 *     carry the original timestamp forward unchanged; no op yet.
 *   - previously tracked, `now - firstMissingAt[url] >= deleteLagMs` ->
 *     emit `removeBookmark`; the url is dropped from the returned map.
 *
 * The returned map is rebuilt from scratch from this run's missing
 * set, which is what makes a reappearance clear its entry "for free":
 * a URL that is desired again this run is simply never added back.
 *
 * When deletes are suppressed (`deletesSuppressed`), this entire step
 * is skipped and the input `firstMissingAt` is returned as a shallow
 * copy, byte-for-byte the same keys and values — per the ruling above,
 * an outage must not arm a delete that fires the moment the slice
 * recovers, so nothing is added, nothing is advanced, and (unlike the
 * normal path) a URL that happens to reappear during a suppressed run
 * is not proactively cleared either; it simply falls out of the map on
 * the next normal run the same way any other resolved entry does.
 */
export function plan(
  desired: DesiredSet,
  actualFolders: readonly ActualFolder[],
  firstMissingAt: FirstMissingAt,
  now: number,
  deleteLagMs: number,
): PlanResult {
  if (desired.status === 'unknown') {
    return { ops: [], firstMissingAt: { ...firstMissingAt } };
  }

  if (actualFolders.length === 1 && !hasDuplicateUrls(actualFolders[0]!.bookmarks)) {
    const folder = actualFolders[0]!;
    if (hashPairs(entriesToPairs(desired.entries)) === hashPairs(bookmarksToPairs(folder.bookmarks))) {
      return { ops: [], firstMissingAt: {} };
    }
  }

  const ops: Op[] = [];
  // Any unknown slice suppresses every delete this run — see the doc
  // comment above. `slices.devices` is always 'ok' when the top-level
  // status is 'ok' (flight #3 forces the whole result to 'unknown'
  // otherwise), so in practice only `slices.services` can trigger this,
  // but both are checked for clarity and in case that guarantee ever
  // changes.
  const deletesSuppressed = desired.slices.devices.status === 'unknown' || desired.slices.services.status === 'unknown';

  // --- rule 4a: duplicate managed folders ------------------------------

  let chosenFolder: ActualFolder | undefined;
  if (actualFolders.length === 0) {
    ops.push({ type: 'createFolder' });
  } else {
    const ranked = [...actualFolders].sort(compareFoldersForSurvivor);
    chosenFolder = ranked[0];
    if (!deletesSuppressed) {
      for (const loser of ranked.slice(1)) {
        ops.push({ type: 'removeDuplicateFolder', folderId: loser.id });
      }
    }
  }

  // --- rule 4b: duplicate URLs within the chosen folder ----------------

  const { survivorByUrl, duplicateLosers } = resolveDuplicateBookmarks(chosenFolder?.bookmarks ?? []);
  if (!deletesSuppressed) {
    for (const loser of duplicateLosers) {
      ops.push({ type: 'removeBookmark', id: loser.id, url: loser.url });
    }
  }

  // --- rules 1 & 2: creates, and title-only updates ---------------------

  for (const url of [...desired.entries.keys()].sort()) {
    const desiredEntry = desired.entries.get(url)!;
    const existing = survivorByUrl.get(url);
    if (!existing) {
      ops.push({ type: 'createBookmark', url, title: desiredEntry.title });
    } else if (existing.title !== desiredEntry.title) {
      ops.push({ type: 'updateTitle', id: existing.id, url, title: desiredEntry.title });
    }
    // existing.title === desiredEntry.title: url and title already
    // match, so rule 2 says nothing is written for this node.
  }

  // --- rule 5: lagged deletes -------------------------------------------

  let nextFirstMissingAt: Record<string, number>;
  if (deletesSuppressed) {
    nextFirstMissingAt = { ...firstMissingAt };
  } else {
    nextFirstMissingAt = {};
    for (const url of [...survivorByUrl.keys()].sort()) {
      if (desired.entries.has(url)) continue;
      const bookmark = survivorByUrl.get(url)!;
      const seenAt = firstMissingAt[url];
      if (seenAt === undefined) {
        nextFirstMissingAt[url] = now;
      } else if (now - seenAt >= deleteLagMs) {
        ops.push({ type: 'removeBookmark', id: bookmark.id, url });
      } else {
        nextFirstMissingAt[url] = seenAt;
      }
    }
  }

  return { ops, firstMissingAt: nextFirstMissingAt };
}

// ---------------------------------------------------------------------
// Duplicate resolution — rule 4
// ---------------------------------------------------------------------

function hasDuplicateUrls(bookmarks: readonly ActualBookmark[]): boolean {
  return new Set(bookmarks.map((b) => b.url)).size !== bookmarks.length;
}

/**
 * Groups bookmarks by URL and picks one survivor per URL via
 * `compareBookmarksForSurvivor`. A URL with only one node has no
 * "loser" at all — it just passes through as its own survivor.
 */
function resolveDuplicateBookmarks(bookmarks: readonly ActualBookmark[]): {
  survivorByUrl: Map<string, ActualBookmark>;
  duplicateLosers: ActualBookmark[];
} {
  const byUrl = new Map<string, ActualBookmark[]>();
  for (const bookmark of bookmarks) {
    const group = byUrl.get(bookmark.url);
    if (group) group.push(bookmark);
    else byUrl.set(bookmark.url, [bookmark]);
  }

  const survivorByUrl = new Map<string, ActualBookmark>();
  const duplicateLosers: ActualBookmark[] = [];
  for (const [url, group] of byUrl) {
    const ranked = [...group].sort(compareBookmarksForSurvivor);
    survivorByUrl.set(url, ranked[0]!);
    duplicateLosers.push(...ranked.slice(1));
  }
  return { survivorByUrl, duplicateLosers };
}

/**
 * DESIGN.md "Convergent identity": duplicates resolve by keeping the
 * oldest `dateAdded`, because `dateAdded` replicates through sync, so
 * every machine reading the same synced records picks the same
 * survivor without coordination.
 *
 * Two duplicate bookmarks share a URL by construction (that's the
 * grouping key), so `dateAdded` is the tie-break DESIGN.md names
 * directly. When *that* also ties — plausible here specifically,
 * since the two most likely duplicates are independent creations of
 * the very same desired entry by two machines racing within one poll
 * interval (DESIGN.md's "Two writers" hazard), which could plausibly
 * fire close enough in wall-clock time to collide — fall back to
 * `title` (lexicographic). Title is real, synced data both machines
 * observe identically once merged, so this still picks the same
 * survivor everywhere without coordination.
 *
 * If dateAdded AND title both tie, the two nodes are observably
 * identical in everything this module is allowed to key on (rule 1
 * rules out `id` and index for *ops*, but nothing stops using `id`
 * purely as an internal, non-emitted tie-break here). `id` is not
 * guaranteed to agree across machines, so in this fully-degenerate
 * case two machines could disagree on which physical node "is" the
 * survivor. That is not the infinite loop DESIGN.md's "Two writers"
 * hazard describes, though: whichever node is deleted, if the URL is
 * still desired it is recreated immediately in the very same run
 * (creates are not lagged), so the worst case is one extra
 * delete-then-recreate cycle before every machine converges on a
 * single node — bounded, not persistent.
 */
function compareBookmarksForSurvivor(a: ActualBookmark, b: ActualBookmark): number {
  return a.dateAdded - b.dateAdded || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/**
 * Same rule for duplicate managed folders, with one difference: every
 * candidate folder passed to `plan` already matches the derived folder
 * name (that's what makes it a candidate), so folder *title* can never
 * discriminate between duplicates the way bookmark title can. After
 * `dateAdded`, this falls straight to `id`, for the same bounded,
 * self-correcting reason as the bookmark tie-break's final step: a
 * losing folder's still-desired contents get recreated in the survivor
 * on this very run.
 */
function compareFoldersForSurvivor(a: ActualFolder, b: ActualFolder): number {
  return a.dateAdded - b.dateAdded || a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------
// Content hash — rule 3
// ---------------------------------------------------------------------

type Pair = readonly [url: string, title: string];

function entriesToPairs(entries: Map<string, DesiredBookmark>): Pair[] {
  return [...entries.entries()].map(([url, entry]) => [url, entry.title] as const);
}

function bookmarksToPairs(bookmarks: readonly ActualBookmark[]): Pair[] {
  return bookmarks.map((b) => [b.url, b.title] as const);
}

/**
 * Hashes a set of (url, title) pairs. Sorted by url first — per flight
 * #3's note, hashing a `Map` (or any array) in iteration order would
 * make the short circuit depend on incidental insertion order
 * surviving every future refactor of `desired-set.ts` or of whatever
 * builds `ActualFolder.bookmarks`, rather than on the content the
 * planner actually cares about.
 */
function hashPairs(pairs: readonly Pair[]): string {
  const canonical = [...pairs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([url, title]) => `${url}\u0000${title}`)
    .join('\u0001');
  return cyrb53(canonical);
}

/**
 * cyrb53 — a small, public-domain, dependency-free non-cryptographic
 * string hash (Bryc, https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js).
 * Chosen deliberately over `crypto.subtle.digest` (a browser API, and
 * async — this module stays sync and has no browser API at all) and
 * over Node's `crypto` module (not available in a MV3 service worker).
 * Collision resistance is not a security requirement here; the only
 * property that matters is determinism given the same input, which
 * this has.
 */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
