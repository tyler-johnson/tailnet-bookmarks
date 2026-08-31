// Flight #5 — the evidence for DESIGN.md's central claim: "a harness
// that simulates two browsers and a sync channel between them can
// assert the op stream goes empty and stays empty." Everything this
// file needs beyond `harness.ts` is `plan()` (via the harness),
// `buildDesiredSet()`, and the plain `DesiredSet`/`TailnetData` types —
// nothing here touches src/lib/planner/*, src/lib/desired-set/*, or
// src/lib/tailscale/* itself.

import { describe, expect, it } from 'vitest';
import { buildDesiredSet } from '../../lib/desired-set';
import type { DesiredBookmark, DesiredSet, SliceOutcome } from '../../lib/desired-set';
import type { TailnetData } from '../../lib/tailscale/types';
import type { Op } from '../../lib/planner';
import { createWorld, runPoll, seedBookmark, seedLocalFolder, seedSharedFolder } from './harness';
import type { World } from './harness';

const INTERVAL = 30 * 60 * 1000; // matches DESIGN.md's default poll interval

// ---------------------------------------------------------------------
// Small builders — mirrors planner.test.ts's own style, reimplemented
// here rather than imported: this file has no business depending on
// planner.ts's test-only internals, and the builders are a few lines.
// ---------------------------------------------------------------------

function bookmarkEntry(url: string, title: string, source: DesiredBookmark['source'] = 'devices'): [string, DesiredBookmark] {
  return [url, { url, title, source }];
}

function desiredOk(entries: [string, DesiredBookmark][], slices: { devices?: SliceOutcome; services?: SliceOutcome } = {}): DesiredSet {
  return {
    status: 'ok',
    tailnetSuffix: 'tail-scale.ts.net',
    entries: new Map(entries),
    slices: {
      devices: slices.devices ?? { status: 'ok' },
      services: slices.services ?? { status: 'ok' },
    },
  };
}

function allOpsEmpty(opsByBrowser: Record<string, Op[]>): boolean {
  return Object.values(opsByBrowser).every((ops) => ops.length === 0);
}

/** Asserts "goes empty and stays empty" against a round-by-round op
 * history: finds the LAST round (if any) that emitted ops from ANY
 * browser, and requires at least `requiredQuietTail` rounds after it —
 * everything from there to the end of `rounds` is empty by
 * construction, so this is a stronger and more honest check than
 * "find the first empty round, then assert monotonic emptiness after
 * it". The two differ exactly when late delivery is in play: a round
 * can look quiet only because a divergent change hasn't been
 * delivered yet, and go non-empty again once it lands — a transient,
 * FALSE quiet period the first-empty-round version would wrongly
 * accept as "stayed quiet" the moment it happened to land early. */
function assertGoesQuietAndStaysQuiet(rounds: readonly Record<string, Op[]>[], requiredQuietTail: number): void {
  let lastNonEmpty = -1;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (!allOpsEmpty(rounds[i]!)) {
      lastNonEmpty = i;
      break;
    }
  }
  expect(lastNonEmpty, `never went quiet at all within ${rounds.length} rounds`).toBeLessThan(rounds.length - 1);
  expect(
    lastNonEmpty,
    `still emitting ops as late as round ${lastNonEmpty + 1} of ${rounds.length} — not enough rounds left to prove it stays quiet`,
  ).toBeLessThanOrEqual(rounds.length - 1 - requiredQuietTail);
}

const DELETE_OP_TYPES: Op['type'][] = ['removeBookmark', 'removeDuplicateFolder'];
function deleteOps(ops: Op[]): Op[] {
  return ops.filter((op) => DELETE_OP_TYPES.includes(op.type));
}

/** A per-browser clock: `base` plus a small, deterministic, per-name
 * offset. Real machines never share a literal `Date.now()` instant, so
 * whenever more than one browser in a scenario can independently
 * create the same node in the same round, `now` must differ browser to
 * browser or the harness manufactures an unrealistic `dateAdded` tie —
 * see the long note on `runPoll` in harness.ts. Discovered directly by
 * this flight: a single shared `now` across browsers (this function's
 * predecessor) made "both browsers populated differently" and
 * "duplicate managed folders on each side" below oscillate forever
 * (createBookmark / removeBookmark, every round, indefinitely) instead
 * of converging — see the flight's closing comment for the full trace. */
function perBrowserNow(base: number): (name: string) => number {
  return (name) => {
    let offset = 0;
    for (const ch of name) offset = (offset * 31 + ch.charCodeAt(0)) % 997;
    return base + offset;
  };
}

// A realistic desired set, built the real way — through `buildDesiredSet`
// — and reused (unchanged) across assertion 1's whole scenario table:
// each scenario is a different *starting actual state*, not a different
// tailnet, matching DESIGN.md's premise that every machine on the
// account reads the same API and agrees on what's desired.
const tailnetData: TailnetData = {
  devices: {
    status: 'ok',
    items: [
      { id: 'n1', name: 'pi.tail-scale.ts.net', hostname: 'pi', addresses: [], os: 'linux', authorized: true, lastSeen: '' },
      { id: 'n2', name: 'starforge.tail-scale.ts.net', hostname: 'starforge', addresses: [], os: 'windows', authorized: true, lastSeen: '' },
    ],
  },
  services: {
    status: 'ok',
    items: [{ name: 'svc:grafana', addrs: [], ports: [{ port: 3000, protocol: 'tcp' }], comment: 'Grafana' }],
  },
};
const tailnetDesired = buildDesiredSet(tailnetData, { devicesEnabled: true, servicesEnabled: true });
if (tailnetDesired.status !== 'ok') throw new Error('fixture desired set must build ok — fix the fixture, not the test');
const tailnetEntries = [...tailnetDesired.entries.entries()] as [string, DesiredBookmark][];
const [URL_PI, ENTRY_PI] = tailnetEntries[0]!;
const [URL_STARFORGE, ENTRY_STARFORGE] = tailnetEntries[1]!;
const [URL_GRAFANA, ENTRY_GRAFANA] = tailnetEntries[2]!;

// ---------------------------------------------------------------------
// Assertion 1 — from any starting divergence, the op stream goes empty
// and stays empty.
// ---------------------------------------------------------------------
//
// Each scenario below seeds a DIFFERENT starting `actual` state on each
// of two browsers sharing one sync channel, then runs many polls and
// checks not just that some later round is quiet, but that once a
// round is quiet, every round after it is too — "goes empty" and
// "stays empty" are two different claims and both are checked.

describe('assertion 1: from any starting divergence, the op stream goes empty and stays empty', () => {
  const scenarios: { name: string; seed: (world: World) => void }[] = [
    {
      name: 'both browsers start empty',
      seed: () => {
        // Nothing seeded. Both browsers independently see zero folders
        // on round 1 and both emit `createFolder` — DESIGN.md's
        // "Independent creation" hazard for the FOLDER itself, arising
        // for free rather than by special-casing it.
      },
    },
    {
      name: 'one browser already fully populated, the other empty',
      seed: (world) => {
        const folder = seedLocalFolder(world, 'A', 500);
        for (const [url, entry] of tailnetEntries) seedBookmark(world, 'A', folder, { url, title: entry.title, dateAdded: 500 });
      },
    },
    {
      name: 'both browsers populated differently (stale entry on one, wrong title on the other)',
      seed: (world) => {
        const folderA = seedLocalFolder(world, 'A', 500);
        seedBookmark(world, 'A', folderA, { url: URL_PI, title: ENTRY_PI.title, dateAdded: 500 });
        seedBookmark(world, 'A', folderA, { url: 'https://retired.tail-scale.ts.net/', title: 'Retired', dateAdded: 400 });

        const folderB = seedLocalFolder(world, 'B', 600);
        seedBookmark(world, 'B', folderB, { url: URL_STARFORGE, title: ENTRY_STARFORGE.title, dateAdded: 600 });
        seedBookmark(world, 'B', folderB, { url: URL_GRAFANA, title: 'stale grafana title', dateAdded: 600 });
      },
    },
    {
      name: 'duplicate managed folders on each side, holding different content',
      seed: (world) => {
        const a1 = seedLocalFolder(world, 'A', 100);
        seedBookmark(world, 'A', a1, { url: URL_PI, title: ENTRY_PI.title, dateAdded: 100 });
        const a2 = seedLocalFolder(world, 'A', 200);
        seedBookmark(world, 'A', a2, { url: URL_STARFORGE, title: ENTRY_STARFORGE.title, dateAdded: 200 });

        const b1 = seedLocalFolder(world, 'B', 150);
        seedBookmark(world, 'B', b1, { url: URL_GRAFANA, title: ENTRY_GRAFANA.title, dateAdded: 150 });
        const b2 = seedLocalFolder(world, 'B', 250);
        seedBookmark(world, 'B', b2, { url: URL_PI, title: ENTRY_PI.title, dateAdded: 250 });
        seedBookmark(world, 'B', b2, { url: 'https://stray.tail-scale.ts.net/', title: 'Stray', dateAdded: 250 });
      },
    },
  ];

  const ROUNDS = 16;
  const REQUIRED_QUIET_TAIL = 4; // rounds proving "stays", not merely "goes"

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const world = createWorld(['A', 'B']);
      scenario.seed(world);

      const rounds: Record<string, Op[]>[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        rounds.push(runPoll(world, { now: perBrowserNow(10_000 + i * INTERVAL), deleteLagMs: INTERVAL, desired: tailnetDesired }));
      }

      assertGoesQuietAndStaysQuiet(rounds, REQUIRED_QUIET_TAIL);
    });
  }
});

// ---------------------------------------------------------------------
// Assertion 2 — a run with a slice marked unknown emits no deletes.
// ---------------------------------------------------------------------
//
// Exercises every delete path rule 4/5 could otherwise take in one
// scenario: a duplicate managed folder, a duplicate URL inside the
// surviving folder, and a bookmark absent from `desired` because its
// source slice failed — all of it real work with real content to fix,
// so this is not a fixture that trivially has nothing to delete.

describe('assertion 2: an unknown slice suppresses every delete this run', () => {
  it('emits no removeBookmark or removeDuplicateFolder, and never applies the suppressed removals either', () => {
    const world = createWorld(['solo']);
    const survivor = seedLocalFolder(world, 'solo', 100, { publish: false });
    const loserFolder = seedLocalFolder(world, 'solo', 200, { publish: false });
    seedBookmark(world, 'solo', loserFolder, { url: 'https://loser-only.tail-scale.ts.net/', title: 'stray', dateAdded: 200 }, { publish: false });

    seedBookmark(world, 'solo', survivor, { url: URL_PI, title: ENTRY_PI.title, dateAdded: 100 }, { publish: false });
    seedBookmark(world, 'solo', survivor, { url: URL_STARFORGE, title: ENTRY_STARFORGE.title, dateAdded: 100 }, { publish: false });
    seedBookmark(world, 'solo', survivor, { url: URL_GRAFANA, title: ENTRY_GRAFANA.title, dateAdded: 100 }, { publish: false });
    seedBookmark(world, 'solo', survivor, { url: URL_GRAFANA, title: ENTRY_GRAFANA.title, dateAdded: 150 }, { publish: false }); // in-folder duplicate URL, younger

    // grafana absent from desired -- would normally arm delete-lag on
    // this and every future poll, but the services slice is unknown.
    const desired = desiredOk([bookmarkEntry(URL_PI, ENTRY_PI.title), bookmarkEntry(URL_STARFORGE, ENTRY_STARFORGE.title)], {
      services: { status: 'unknown', reason: 'vip-services fetch failed' },
    });

    const round1 = runPoll(world, { now: 10_000, deleteLagMs: INTERVAL, desired });
    expect(deleteOps(round1.solo!)).toEqual([]);

    // Run again well past the delete lag -- still unknown, still no deletes.
    const round2 = runPoll(world, { now: 10_000 + 3 * INTERVAL, deleteLagMs: INTERVAL, desired });
    expect(deleteOps(round2.solo!)).toEqual([]);

    // Suppression means the losers were never actually applied, not
    // merely omitted from this run's op list.
    const browser = world.browsers.get('solo')!;
    expect(browser.folders).toHaveLength(2);
    const survivorNow = browser.folders.find((f) => f.syncId === survivor.syncId)!;
    expect(survivorNow.bookmarks.filter((b) => b.url === URL_GRAFANA)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------
// Assertion 3 — the same URL created independently on both sides
// collapses to one node, and both sides keep the SAME survivor.
// ---------------------------------------------------------------------
//
// The heart of the harness: the sync channel merges by `syncId`, never
// by `url`. Both browsers start from one already-shared managed folder
// (so the thing under test is bookmark identity, not folder identity —
// assertion 1's "duplicate folders on each side" scenario already
// covers that), then EACH independently creates its own node for the
// same URL with a distinct `syncId` and a distinct `dateAdded`. Once
// the sync channel delivers both creates to both sides, rule 4 must
// pick the SAME survivor everywhere -- checked by identity (`syncId`),
// not merely by counting one surviving node per side.

describe('assertion 3: independent creation of the same URL collapses to one node, same survivor everywhere', () => {
  it('keeps the older node on both sides, by syncId', () => {
    const world = createWorld(['A', 'B']);
    const { foldersByBrowser } = seedSharedFolder(world, ['A', 'B'], 100);
    const url = 'https://shared.tail-scale.ts.net/';

    // Independent creation: two different nodes, two different
    // dateAddeds so rule 4's tie-break has a real, unambiguous answer
    // to converge on (a dateAdded tie is the one genuinely degenerate
    // case planner.ts's own doc comment calls out as merely bounded,
    // not deterministic -- deliberately avoided here so this assertion
    // can check for an EXACT matching survivor, not just eventual
    // single-node convergence, which assertion 1 already covers).
    const older = seedBookmark(world, 'A', foldersByBrowser.get('A')!, { url, title: 'Shared', dateAdded: 1000 });
    const newer = seedBookmark(world, 'B', foldersByBrowser.get('B')!, { url, title: 'Shared', dateAdded: 2000 });

    const desired = desiredOk([bookmarkEntry(url, 'Shared')]);

    const rounds: Record<string, Op[]>[] = [];
    for (let i = 0; i < 6; i++) {
      rounds.push(runPoll(world, { now: 50_000 + i * INTERVAL, deleteLagMs: INTERVAL, desired }));
    }

    expect(allOpsEmpty(rounds[rounds.length - 1]!)).toBe(true);

    const browserA = world.browsers.get('A')!;
    const browserB = world.browsers.get('B')!;
    const bookmarksAForUrl = browserA.folders.flatMap((f) => f.bookmarks).filter((b) => b.url === url);
    const bookmarksBForUrl = browserB.folders.flatMap((f) => f.bookmarks).filter((b) => b.url === url);

    expect(bookmarksAForUrl).toHaveLength(1);
    expect(bookmarksBForUrl).toHaveLength(1);
    expect(bookmarksAForUrl[0]!.syncId).toBe(older.syncId);
    expect(bookmarksBForUrl[0]!.syncId).toBe(older.syncId);
    expect(bookmarksAForUrl[0]!.syncId).toBe(bookmarksBForUrl[0]!.syncId);
    expect(newer.syncId).not.toBe(older.syncId); // sanity: they really were two different nodes to begin with
  });
});

// ---------------------------------------------------------------------
// Assertion 4 — the steady state emits zero ops per run, indefinitely.
// ---------------------------------------------------------------------
//
// Both browsers start ALREADY converged (a real prior history, not
// something this test has to earn) and desired never changes across
// many, many rounds. Every single round must be zero ops on both
// sides, not just the first couple.

describe('assertion 4: the steady state emits zero ops per run, indefinitely', () => {
  it('stays at zero ops for 40 consecutive polls', () => {
    const world = createWorld(['A', 'B']);
    const { foldersByBrowser } = seedSharedFolder(world, ['A', 'B'], 100);
    const entries: [string, DesiredBookmark][] = [bookmarkEntry(URL_PI, ENTRY_PI.title), bookmarkEntry(URL_STARFORGE, ENTRY_STARFORGE.title)];
    const desired = desiredOk(entries);

    for (const [name, folder] of foldersByBrowser) {
      for (const [url, entry] of entries) {
        seedBookmark(world, name, folder, { url, title: entry.title, dateAdded: 100 }, { publish: false });
      }
    }

    const ROUNDS = 40;
    for (let i = 0; i < ROUNDS; i++) {
      const ops = runPoll(world, { now: 10_000 + i * INTERVAL, deleteLagMs: INTERVAL, desired });
      expect(ops.A, `round ${i + 1}`).toEqual([]);
      expect(ops.B, `round ${i + 1}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------
// DESIGN.md's third hazard — late delivery.
// ---------------------------------------------------------------------
//
// A convergence proof that only ever tests same-poll-plus-one delivery
// is weaker than the design: DESIGN.md "Late delivery" says sync
// changes "can land minutes after a browser starts". Rerunning
// assertion 1's "one populated, one empty" scenario with a much longer
// `deliveryDelayTicks` checks the same "goes empty and stays empty"
// property holds even when a browser is reconciling against a
// partially-synced tree for many polls in a row, not just one.

describe('hazard: late delivery does not prevent convergence, only delays it', () => {
  it('goes empty and stays empty with a 5-poll delivery delay', () => {
    const world = createWorld(['A', 'B']);
    const DELAY = 5;
    const folder = seedLocalFolder(world, 'A', 500, { deliveryDelayTicks: DELAY });
    for (const [url, entry] of tailnetEntries) {
      seedBookmark(world, 'A', folder, { url, title: entry.title, dateAdded: 500 }, { deliveryDelayTicks: DELAY });
    }

    const ROUNDS = 24;
    const REQUIRED_QUIET_TAIL = 6;
    const rounds: Record<string, Op[]>[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      rounds.push(runPoll(world, { now: perBrowserNow(10_000 + i * INTERVAL), deleteLagMs: INTERVAL, desired: tailnetDesired, deliveryDelayTicks: DELAY }));
    }

    assertGoesQuietAndStaysQuiet(rounds, REQUIRED_QUIET_TAIL);

    // Both browsers converged on ONE shared folder identity, not two
    // that each independently happened to look locally satisfied.
    const browserA = world.browsers.get('A')!;
    const browserB = world.browsers.get('B')!;
    expect(browserA.folders).toHaveLength(1);
    expect(browserB.folders).toHaveLength(1);
    expect(browserA.folders[0]!.syncId).toBe(browserB.folders[0]!.syncId);
  });
});
