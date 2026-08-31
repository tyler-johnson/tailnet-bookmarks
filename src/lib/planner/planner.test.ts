import { describe, expect, it } from 'vitest';
import type { DesiredBookmark, DesiredSet, SliceOutcome } from '../desired-set';
import { plan } from './planner';
import type { ActualBookmark, ActualFolder, Op } from './planner';

const HOUR = 60 * 60 * 1000;
const INTERVAL = 30 * 60 * 1000; // matches DESIGN.md's default poll interval

// ---------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------

function bookmark(url: string, title: string, source: DesiredBookmark['source'] = 'devices'): [string, DesiredBookmark] {
  return [url, { url, title, source }];
}

function desiredOk(
  entries: [string, DesiredBookmark][],
  slices: { devices?: SliceOutcome; services?: SliceOutcome } = {},
): DesiredSet {
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

function desiredUnknown(reason = 'devices slice failed'): DesiredSet {
  return { status: 'unknown', reason };
}

let nextId = 1;
function actualBookmark(url: string, title: string, dateAdded: number, id?: string): ActualBookmark {
  return { id: id ?? `bm${nextId++}`, url, title, dateAdded };
}

function folder(dateAdded: number, bookmarks: ActualBookmark[], id?: string): ActualFolder {
  return { id: id ?? `folder${nextId++}`, dateAdded, bookmarks };
}

function opsOfType(ops: Op[], type: Op['type']): Op[] {
  return ops.filter((op) => op.type === type);
}

// ---------------------------------------------------------------------
// Top-level `unknown` DesiredSet: no ops of any kind
// ---------------------------------------------------------------------

describe('DesiredSet status "unknown"', () => {
  it('emits no ops at all and leaves firstMissingAt untouched', () => {
    const actual = [folder(1000, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1000)])];
    const priorMissing = { 'https://gone.tail-scale.ts.net/': 500 };
    const result = plan(desiredUnknown(), actual, priorMissing, 100_000, INTERVAL);

    expect(result.ops).toEqual([]);
    expect(result.firstMissingAt).toEqual(priorMissing);
  });

  it('does nothing even when actual has duplicate folders and duplicate URLs', () => {
    const dupBookmarks = [
      actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1000, 'a'),
      actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 2000, 'b'),
    ];
    const actual = [folder(1000, dupBookmarks, 'f1'), folder(500, [], 'f2')];
    const result = plan(desiredUnknown(), actual, {}, 100_000, INTERVAL);

    expect(result.ops).toEqual([]);
    expect(result.firstMissingAt).toEqual({});
  });
});

// ---------------------------------------------------------------------
// Rule 3: content-hash short circuit
// ---------------------------------------------------------------------

describe('rule 3: content-hash short circuit', () => {
  it('emits zero ops when the single folder already matches desired exactly', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi'), bookmark('https://vm.tail-scale.ts.net/', 'vm')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 5000),
        actualBookmark('https://vm.tail-scale.ts.net/', 'vm', 6000),
      ]),
    ];

    const result = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(result.ops).toEqual([]);
  });

  it('is insensitive to Map insertion order on the desired side', () => {
    const actual = [
      folder(1000, [
        actualBookmark('https://a.tail-scale.ts.net/', 'a', 1),
        actualBookmark('https://b.tail-scale.ts.net/', 'b', 2),
        actualBookmark('https://c.tail-scale.ts.net/', 'c', 3),
      ]),
    ];
    const forward = desiredOk([bookmark('https://a.tail-scale.ts.net/', 'a'), bookmark('https://b.tail-scale.ts.net/', 'b'), bookmark('https://c.tail-scale.ts.net/', 'c')]);
    const shuffled = desiredOk([bookmark('https://c.tail-scale.ts.net/', 'c'), bookmark('https://a.tail-scale.ts.net/', 'a'), bookmark('https://b.tail-scale.ts.net/', 'b')]);

    expect(plan(forward, actual, {}, 100_000, INTERVAL).ops).toEqual([]);
    expect(plan(shuffled, actual, {}, 100_000, INTERVAL).ops).toEqual([]);
  });

  it('ignores id and dateAdded — only url and title feed the hash', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actualA = [folder(1, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 999, 'x')])];
    const actualB = [folder(999_999, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1, 'totally-different-id')])];

    expect(plan(desired, actualA, {}, 100_000, INTERVAL).ops).toEqual([]);
    expect(plan(desired, actualB, {}, 100_000, INTERVAL).ops).toEqual([]);
  });

  it('clears stale firstMissingAt entries on an exact match', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [folder(1000, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1000)])];
    const prior = { 'https://old.tail-scale.ts.net/': 500 };

    const result = plan(desired, actual, prior, 100_000, INTERVAL);
    expect(result.firstMissingAt).toEqual({});
  });

  it('does not short-circuit when there are zero candidate folders', () => {
    const desired = desiredOk([]);
    const result = plan(desired, [], {}, 100_000, INTERVAL);
    expect(opsOfType(result.ops, 'createFolder')).toHaveLength(1);
  });

  it('does not short-circuit when there are multiple candidate folders, even if content matches', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [
      folder(1000, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1000)], 'older'),
      folder(2000, [actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 2000)], 'newer'),
    ];
    const result = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(opsOfType(result.ops, 'removeDuplicateFolder')).toEqual([{ type: 'removeDuplicateFolder', folderId: 'newer' }]);
  });

  it('does not short-circuit when the single folder holds a duplicate URL, even if the desired content is otherwise satisfied', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 1000, 'older'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 2000, 'newer'),
      ]),
    ];
    const result = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(result.ops).toEqual([{ type: 'removeBookmark', id: 'newer', url: 'https://pi.tail-scale.ts.net/' }]);
  });
});

// ---------------------------------------------------------------------
// Rule 1: key on URL, no index/ordering op representable
// ---------------------------------------------------------------------

describe('rule 1: key on URL, never an index or ordering op', () => {
  it('has no index/position field on any Op variant (compile-time)', () => {
    // If a future edit ever added an `index` or `position` field to any
    // Op variant, this mapped type would stop being assignable from a
    // plain `true`, and svelte-check / tsc would fail the build.
    type NoOrderingField<T> = T extends { index: unknown } | { position: unknown } ? never : true;
    type Check = { [K in Op['type']]: NoOrderingField<Extract<Op, { type: K }>> };
    const proof: Check = {
      createFolder: true,
      removeDuplicateFolder: true,
      createBookmark: true,
      updateTitle: true,
      removeBookmark: true,
    };
    expect(proof.createFolder).toBe(true);
  });

  it('produces no op carrying an index or position key at runtime, across every op kind', () => {
    const desired = desiredOk([bookmark('https://new.tail-scale.ts.net/', 'new'), bookmark('https://renamed.tail-scale.ts.net/', 'new title')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://renamed.tail-scale.ts.net/', 'old title', 1000),
        actualBookmark('https://stale.tail-scale.ts.net/', 'stale', 1000),
      ]),
    ];
    const priorMissing = { 'https://stale.tail-scale.ts.net/': 0 };
    const { ops } = plan(desired, actual, priorMissing, INTERVAL, INTERVAL);

    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(Object.keys(op)).not.toContain('index');
      expect(Object.keys(op)).not.toContain('position');
    }
  });

  it('is insensitive to the order of actual bookmarks within the folder', () => {
    const desired = desiredOk([bookmark('https://a.tail-scale.ts.net/', 'a'), bookmark('https://b.tail-scale.ts.net/', 'b renamed')]);
    const nodesA = [actualBookmark('https://a.tail-scale.ts.net/', 'a', 1), actualBookmark('https://b.tail-scale.ts.net/', 'b', 2)];
    const nodesB = [...nodesA].reverse();

    const resultA = plan(desired, [folder(1000, nodesA, 'f')], {}, 100_000, INTERVAL);
    const resultB = plan(desired, [folder(1000, nodesB, 'f')], {}, 100_000, INTERVAL);

    expect(resultA.ops).toEqual(resultB.ops);
  });
});

// ---------------------------------------------------------------------
// Rule 2: never update a node whose title and URL already match
// ---------------------------------------------------------------------

describe('rule 2: never update a node whose title and URL already match', () => {
  it('emits no updateTitle for a node that already matches, alongside one that does not', () => {
    const desired = desiredOk([bookmark('https://match.tail-scale.ts.net/', 'already correct'), bookmark('https://drift.tail-scale.ts.net/', 'new title')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://match.tail-scale.ts.net/', 'already correct', 1),
        actualBookmark('https://drift.tail-scale.ts.net/', 'old title', 2, 'drift-id'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'updateTitle', id: 'drift-id', url: 'https://drift.tail-scale.ts.net/', title: 'new title' }]);
  });

  it('title comparison is case- and whitespace-sensitive (exact match only)', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [folder(1000, [actualBookmark('https://pi.tail-scale.ts.net/', 'Pi', 1, 'id')])];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'updateTitle', id: 'id', url: 'https://pi.tail-scale.ts.net/', title: 'pi' }]);
  });
});

// ---------------------------------------------------------------------
// Rule 4: duplicates resolve to the oldest dateAdded
// ---------------------------------------------------------------------

describe('rule 4: duplicate URLs within the folder', () => {
  it('keeps the older node and removes the newer one', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'older'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 900, 'newer'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'removeBookmark', id: 'newer', url: 'https://pi.tail-scale.ts.net/' }]);
  });

  it('is order-independent: the older node survives regardless of array position', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const older = actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'older');
    const newer = actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 900, 'newer');

    const resultA = plan(desired, [folder(1000, [older, newer], 'f')], {}, 100_000, INTERVAL);
    const resultB = plan(desired, [folder(1000, [newer, older], 'f')], {}, 100_000, INTERVAL);

    expect(resultA.ops).toEqual([{ type: 'removeBookmark', id: 'newer', url: 'https://pi.tail-scale.ts.net/' }]);
    expect(resultB.ops).toEqual(resultA.ops);
  });

  it('falls back to lexicographically-first title when dateAdded ties', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'alpha')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'zzz', 500, 'z-node'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'aaa', 500, 'a-node'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    // survivor is a-node (title "aaa" sorts first); it then needs a
    // title update to match desired, and z-node is removed as the loser.
    expect(ops).toContainEqual({ type: 'removeBookmark', id: 'z-node', url: 'https://pi.tail-scale.ts.net/' });
    expect(ops).toContainEqual({ type: 'updateTitle', id: 'a-node', url: 'https://pi.tail-scale.ts.net/', title: 'alpha' });
  });

  it('flight #9: emits no removal when dateAdded and title both tie — id is local and does not replicate', () => {
    // A tie on both dateAdded and title leaves nothing to order the
    // pair by except `id`, which is local per browser. Deciding a
    // removal on it is exactly the flight #9 defect: two machines can
    // pick opposite survivors, each deletes the other's, and both
    // copies vanish and get recreated forever. The fix withholds the
    // removeBookmark op for this group entirely rather than guessing.
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'zid'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'aid'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([]);
  });

  it('still resolves normally (survivor kept, loser removed) when dateAdded actually orders the group', () => {
    // A duplicate group that CAN be ordered by data that replicates —
    // dateAdded differs — is unaffected by the flight #9 fix and still
    // removes the loser, same as before.
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'older'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 900, 'newer'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'removeBookmark', id: 'newer', url: 'https://pi.tail-scale.ts.net/' }]);
  });

  it('suppresses the removal (but still resolves a survivor for content diffing) when a slice is unknown', () => {
    const desired = desiredOk([bookmark('https://pi.tail-scale.ts.net/', 'pi')], { services: { status: 'unknown', reason: 'x' } });
    const actual = [
      folder(1000, [
        actualBookmark('https://pi.tail-scale.ts.net/', 'pi', 500, 'older'),
        actualBookmark('https://pi.tail-scale.ts.net/', 'wrong title', 900, 'newer'),
      ]),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(opsOfType(ops, 'removeBookmark')).toEqual([]);
  });
});

describe('rule 4: duplicate managed folders', () => {
  it('removes every folder but the oldest', () => {
    const desired = desiredOk([]);
    const actual = [folder(3000, [], 'youngest'), folder(1000, [], 'oldest'), folder(2000, [], 'middle')];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(opsOfType(ops, 'removeDuplicateFolder').map((op) => (op as Extract<Op, { type: 'removeDuplicateFolder' }>).folderId).sort()).toEqual(['middle', 'youngest']);
  });

  it('plans bookmark content against the surviving (oldest) folder', () => {
    const desired = desiredOk([bookmark('https://only-in-old.tail-scale.ts.net/', 'x')]);
    const actual = [
      folder(1000, [actualBookmark('https://only-in-old.tail-scale.ts.net/', 'x', 1)], 'oldest'),
      folder(2000, [actualBookmark('https://only-in-new.tail-scale.ts.net/', 'y', 2)], 'newest'),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    // The oldest folder already has the one desired bookmark correct,
    // so the only ops are dropping the duplicate folder outright.
    expect(ops).toEqual([{ type: 'removeDuplicateFolder', folderId: 'newest' }]);
  });

  it('recreates content that only existed in a losing duplicate folder, in the same run', () => {
    const desired = desiredOk([bookmark('https://only-in-new.tail-scale.ts.net/', 'y')]);
    const actual = [
      folder(1000, [], 'oldest'),
      folder(2000, [actualBookmark('https://only-in-new.tail-scale.ts.net/', 'y', 2)], 'newest'),
    ];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toContainEqual({ type: 'removeDuplicateFolder', folderId: 'newest' });
    expect(ops).toContainEqual({ type: 'createBookmark', url: 'https://only-in-new.tail-scale.ts.net/', title: 'y' });
  });

  it('flight #9: emits no removal when duplicate folders share dateAdded — title never discriminates and id is local', () => {
    // Folder title can never discriminate duplicates (every candidate
    // already matches the derived name), so a dateAdded tie leaves
    // only `id`, which does not replicate. The fix withholds
    // removeDuplicateFolder for this group rather than deciding by id.
    const desired = desiredOk([]);
    const actual = [folder(1000, [], 'zzz'), folder(1000, [], 'aaa')];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([]);
  });

  it('still removes the loser when dateAdded actually orders the duplicate folders', () => {
    const desired = desiredOk([]);
    const actual = [folder(2000, [], 'newer'), folder(1000, [], 'older')];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'removeDuplicateFolder', folderId: 'newer' }]);
  });

  it('suppresses removeDuplicateFolder when a slice is unknown, but still diffs content against the chosen survivor', () => {
    const desired = desiredOk([bookmark('https://a.tail-scale.ts.net/', 'a')], { services: { status: 'unknown', reason: 'x' } });
    const actual = [folder(1000, [actualBookmark('https://a.tail-scale.ts.net/', 'a', 1)], 'oldest'), folder(2000, [], 'newest')];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toEqual([]);
  });

  it('still creates the folder when none exists, even with a slice unknown', () => {
    const desired = desiredOk([], { services: { status: 'unknown', reason: 'x' } });
    const { ops } = plan(desired, [], {}, 100_000, INTERVAL);
    expect(ops).toEqual([{ type: 'createFolder' }]);
  });
});

// ---------------------------------------------------------------------
// Per-flight ruling: any unknown slice suppresses ALL deletes
// ---------------------------------------------------------------------

describe('unknown-slice ruling: no deletes of any kind this run', () => {
  it('suppresses a lagged delete that would otherwise fire', () => {
    const desired = desiredOk([], { services: { status: 'unknown', reason: 'vip-services 500' } });
    const actual = [folder(1000, [actualBookmark('https://svc.tail-scale.ts.net/', 'svc', 1, 'svc-id')])];
    const now = 1_000_000;
    const priorMissing = { 'https://svc.tail-scale.ts.net/': now - INTERVAL - 1 };

    const { ops, firstMissingAt } = plan(desired, actual, priorMissing, now, INTERVAL);
    expect(opsOfType(ops, 'removeBookmark')).toEqual([]);
    expect(firstMissingAt).toEqual(priorMissing);
  });

  it('does not start tracking newly-missing URLs while a slice is unknown', () => {
    const desired = desiredOk([], { services: { status: 'unknown', reason: 'vip-services 500' } });
    const actual = [folder(1000, [actualBookmark('https://svc.tail-scale.ts.net/', 'svc', 1)])];

    const { firstMissingAt } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(firstMissingAt).toEqual({});
  });

  it('still applies creates and title updates while a slice is unknown', () => {
    const desired = desiredOk(
      [bookmark('https://new.tail-scale.ts.net/', 'new'), bookmark('https://drift.tail-scale.ts.net/', 'fresh title')],
      { services: { status: 'unknown', reason: 'x' } },
    );
    const actual = [folder(1000, [actualBookmark('https://drift.tail-scale.ts.net/', 'old title', 1, 'drift-id')])];

    const { ops } = plan(desired, actual, {}, 100_000, INTERVAL);
    expect(ops).toContainEqual({ type: 'createBookmark', url: 'https://new.tail-scale.ts.net/', title: 'new' });
    expect(ops).toContainEqual({ type: 'updateTitle', id: 'drift-id', url: 'https://drift.tail-scale.ts.net/', title: 'fresh title' });
  });

  it('a full outage-then-recovery cycle arms and fires the delete only after two known-good polls', () => {
    // Poll 1: services unknown. svc bookmark looks "missing" but nothing
    // is tracked and nothing is deleted.
    const desired1 = desiredOk([], { services: { status: 'unknown', reason: 'x' } });
    const actual = [folder(1000, [actualBookmark('https://svc.tail-scale.ts.net/', 'svc', 1, 'svc-id')])];
    const r1 = plan(desired1, actual, {}, 0, INTERVAL);
    expect(r1.ops).toEqual([]);
    expect(r1.firstMissingAt).toEqual({});

    // Poll 2: services recovered, but this service is genuinely gone
    // from the tailnet now. First known-good "missing" observation.
    const desired2 = desiredOk([]);
    const r2 = plan(desired2, actual, r1.firstMissingAt, INTERVAL, INTERVAL);
    expect(r2.ops).toEqual([]);
    expect(r2.firstMissingAt).toEqual({ 'https://svc.tail-scale.ts.net/': INTERVAL });

    // Poll 3, one interval later: second known-good "missing"
    // observation, at least deleteLagMs after the first -> delete fires.
    const r3 = plan(desired2, actual, r2.firstMissingAt, 2 * INTERVAL, INTERVAL);
    expect(r3.ops).toEqual([{ type: 'removeBookmark', id: 'svc-id', url: 'https://svc.tail-scale.ts.net/' }]);
    expect(r3.firstMissingAt).toEqual({});
  });
});

// ---------------------------------------------------------------------
// Rule 5: lagged deletes, simulated across consecutive runs
// ---------------------------------------------------------------------

describe('rule 5: lagged deletes', () => {
  it('does not delete on the first poll where a URL is missing; starts tracking it', () => {
    const desired = desiredOk([]);
    const actual = [folder(1000, [actualBookmark('https://gone.tail-scale.ts.net/', 'gone', 1, 'gone-id')])];

    const { ops, firstMissingAt } = plan(desired, actual, {}, 5000, INTERVAL);
    expect(ops).toEqual([]);
    expect(firstMissingAt).toEqual({ 'https://gone.tail-scale.ts.net/': 5000 });
  });

  it('does not delete before the interval has elapsed, and keeps the original timestamp', () => {
    const desired = desiredOk([]);
    const actual = [folder(1000, [actualBookmark('https://gone.tail-scale.ts.net/', 'gone', 1, 'gone-id')])];
    const priorMissing = { 'https://gone.tail-scale.ts.net/': 5000 };

    const { ops, firstMissingAt } = plan(desired, actual, priorMissing, 5000 + INTERVAL - 1, INTERVAL);
    expect(ops).toEqual([]);
    expect(firstMissingAt).toEqual({ 'https://gone.tail-scale.ts.net/': 5000 });
  });

  it('deletes once now - firstMissingAt >= deleteLagMs, and drops the entry', () => {
    const desired = desiredOk([]);
    const actual = [folder(1000, [actualBookmark('https://gone.tail-scale.ts.net/', 'gone', 1, 'gone-id')])];
    const priorMissing = { 'https://gone.tail-scale.ts.net/': 5000 };

    const { ops, firstMissingAt } = plan(desired, actual, priorMissing, 5000 + INTERVAL, INTERVAL);
    expect(ops).toEqual([{ type: 'removeBookmark', id: 'gone-id', url: 'https://gone.tail-scale.ts.net/' }]);
    expect(firstMissingAt).toEqual({});
  });

  it('clears the entry if the URL reappears in desired before the second run', () => {
    const desired = desiredOk([bookmark('https://back.tail-scale.ts.net/', 'back')]);
    const actual = [folder(1000, [actualBookmark('https://back.tail-scale.ts.net/', 'back', 1, 'back-id')])];
    const priorMissing = { 'https://back.tail-scale.ts.net/': 5000 };

    const { ops, firstMissingAt } = plan(desired, actual, priorMissing, 5000 + INTERVAL, INTERVAL);
    expect(ops).toEqual([]);
    expect(firstMissingAt).toEqual({});
  });

  it('respects a caller-supplied interval rather than a hardcoded 30 minutes', () => {
    const desired = desiredOk([]);
    const actual = [folder(1000, [actualBookmark('https://gone.tail-scale.ts.net/', 'gone', 1, 'gone-id')])];
    const priorMissing = { 'https://gone.tail-scale.ts.net/': 5000 };
    const fiveMinutes = 5 * 60 * 1000;

    const tooSoon = plan(desired, actual, priorMissing, 5000 + fiveMinutes - 1, fiveMinutes);
    expect(tooSoon.ops).toEqual([]);

    const dueNow = plan(desired, actual, priorMissing, 5000 + fiveMinutes, fiveMinutes);
    expect(dueNow.ops).toEqual([{ type: 'removeBookmark', id: 'gone-id', url: 'https://gone.tail-scale.ts.net/' }]);
  });

  it('tracks multiple missing URLs independently across runs', () => {
    const desired = desiredOk([]);
    const actual = [
      folder(1000, [
        actualBookmark('https://a.tail-scale.ts.net/', 'a', 1, 'a-id'),
        actualBookmark('https://b.tail-scale.ts.net/', 'b', 1, 'b-id'),
      ]),
    ];

    // a goes missing at t=0; b goes missing later, tracked starting t=1000.
    const r1 = plan(desired, actual, {}, 0, INTERVAL);
    expect(r1.firstMissingAt).toEqual({ 'https://a.tail-scale.ts.net/': 0, 'https://b.tail-scale.ts.net/': 0 });

    // At t = INTERVAL, both are due (both were first seen missing at 0).
    const r2 = plan(desired, actual, r1.firstMissingAt, INTERVAL, INTERVAL);
    expect(opsOfType(r2.ops, 'removeBookmark')).toHaveLength(2);
    expect(r2.firstMissingAt).toEqual({});
  });
});

// ---------------------------------------------------------------------
// Steady state: zero ops, indefinitely, across repeated runs
// ---------------------------------------------------------------------

describe('steady state', () => {
  it('costs zero ops across repeated runs once actual matches desired', () => {
    const desired = desiredOk([bookmark('https://a.tail-scale.ts.net/', 'a'), bookmark('https://svc.tail-scale.ts.net/', 'svc', 'services')]);
    const actual = [
      folder(1000, [
        actualBookmark('https://a.tail-scale.ts.net/', 'a', 1),
        actualBookmark('https://svc.tail-scale.ts.net/', 'svc', 2),
      ]),
    ];

    let firstMissingAt: Record<string, number> = {};
    for (let run = 0; run < 5; run++) {
      const now = run * HOUR;
      const result = plan(desired, actual, firstMissingAt, now, INTERVAL);
      expect(result.ops).toEqual([]);
      firstMissingAt = result.firstMissingAt;
    }
    expect(firstMissingAt).toEqual({});
  });
});
