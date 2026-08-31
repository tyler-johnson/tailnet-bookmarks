import { describe, expect, it, vi } from 'vitest';
import { runReconcile, type RunInputs } from './run';
import { devicesResponseFixture, vipServicesResponseFixture } from '../tailscale/fixtures';
import type { BookmarksAPI } from '../applier';
import type { CachedToken, TokenStore } from '../tailscale';
import type { Browser } from 'wxt/browser';

type Node = Browser.bookmarks.BookmarkTreeNode;

const CREDENTIALS = { clientId: 'client-1', clientSecret: 'secret-1' };
const TOGGLES = { devicesEnabled: true, servicesEnabled: true };

/** id each engine assigns its "Other Bookmarks"/"Andere Lesezeichen" root
 * at profile creation — see storage.ts's KNOWN_ROOT_IDS. Used here so
 * `resolveFolderRootId` resolves 'other' the same way it would on a real
 * Firefox profile, without depending on `folderType` (Chrome 134+ only). */
const OTHER_ROOT_ID = 'unfiled_____';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch fake that answers the token endpoint and both tailnet reads
 * with the shared fixtures, or a 500 for whichever URLs are listed in
 * `fail`, mirroring src/lib/tailscale/client.test.ts's approach. */
function fakeFetch(fail: readonly ('devices' | 'services')[] = []): FetchImpl {
  return vi.fn<FetchImpl>(async (input) => {
    const url = String(input);
    if (url.includes('/oauth/token')) return jsonResponse({ access_token: 'fixture-token', expires_in: 3600 });
    if (url.includes('/devices')) {
      return fail.includes('devices') ? jsonResponse({}, { status: 500 }) : jsonResponse(devicesResponseFixture);
    }
    if (url.includes('/vip-services')) {
      return fail.includes('services') ? jsonResponse({}, { status: 500 }) : jsonResponse(vipServicesResponseFixture);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function memoryTokenStore(): TokenStore {
  let value: CachedToken | undefined;
  return {
    async get() {
      return value;
    },
    async set(token) {
      value = token;
    },
    async clear() {
      value = undefined;
    },
  };
}

/** In-memory `browser.bookmarks` fake. `roots` seeds the top-level nodes
 * `getTree()` reports (the toolbar/menu/other roots); everything else is
 * ordinary create/update/remove bookkeeping, same shape as
 * src/lib/applier/applier.test.ts's fake. */
function fakeBookmarksAPI(seed: Node[] = []): BookmarksAPI & { nodes: Map<string, Node> } {
  const nodes = new Map<string, Node>(seed.map((n) => [n.id, n]));
  let nextId = 1000;

  return {
    nodes,
    async getTree() {
      const roots = [...nodes.values()].filter((n) => n.parentId === undefined);
      return [{ id: '0', title: 'root', syncing: false, children: roots } as Node];
    },
    async getChildren(id) {
      return [...nodes.values()].filter((n) => n.parentId === id);
    },
    async create(bookmark) {
      const id = String(nextId++);
      const node: Node = {
        id,
        parentId: bookmark.parentId,
        title: bookmark.title,
        url: bookmark.url,
        dateAdded: Date.now(),
        syncing: false,
      };
      nodes.set(id, node);
      return node;
    },
    async update(id, changes) {
      const node = nodes.get(id);
      if (!node) throw new Error(`no such bookmark: ${id}`);
      const updated = { ...node, ...changes };
      nodes.set(id, updated);
      return updated;
    },
    async remove(id) {
      if (!nodes.has(id)) throw new Error(`no such bookmark: ${id}`);
      nodes.delete(id);
    },
    async removeTree(id) {
      if (!nodes.has(id)) throw new Error(`no such folder: ${id}`);
      nodes.delete(id);
      for (const n of [...nodes.values()]) if (n.parentId === id) nodes.delete(n.id);
    },
  };
}

function baseInputs(overrides: Partial<RunInputs> = {}): RunInputs {
  return {
    credentials: CREDENTIALS,
    toggles: TOGGLES,
    folderParentSymbol: 'other',
    firstMissingAt: {},
    now: 1_000_000,
    deleteLagMs: 30 * 60_000,
    bookmarks: fakeBookmarksAPI([{ id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false }]),
    tokenStore: memoryTokenStore(),
    fetchImpl: fakeFetch(),
    ...overrides,
  };
}

describe('runReconcile', () => {
  it('returns no-parent when the configured root symbol does not resolve on this machine', async () => {
    // A Chromium-shaped tree (only 'other'/'toolbar' roots, no 'menu'),
    // asked to resolve 'menu' — the documented case from storage.ts.
    const bookmarks = fakeBookmarksAPI([{ id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false }]);
    const outcome = await runReconcile(baseInputs({ bookmarks, folderParentSymbol: 'menu' }));
    expect(outcome).toEqual({ status: 'no-parent', folderParentSymbol: 'menu' });
  });

  it('returns aborted, with firstMissingAt unchanged, when the devices slice fails', async () => {
    const outcome = await runReconcile(
      baseInputs({ fetchImpl: fakeFetch(['devices']), firstMissingAt: { 'https://stale.example/': 500 } }),
    );
    expect(outcome.status).toBe('aborted');
    if (outcome.status === 'aborted') {
      expect(outcome.firstMissingAt).toEqual({ 'https://stale.example/': 500 });
    }
  });

  it('creates the folder and every desired bookmark on a first run against an empty parent', async () => {
    const bookmarks = fakeBookmarksAPI([{ id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false }]);
    const outcome = await runReconcile(baseInputs({ bookmarks }));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;

    // 2 devices + 2 services (grafana: TCP/3000 only -> http, port kept
    // explicit; paperless: TCP/80+443 -> https, no port) = 4 desired
    // bookmarks, per desired-set.ts's own rules.
    expect(outcome.created).toBe(4);
    expect(outcome.updated).toBe(0);
    expect(outcome.removed).toBe(0);

    const folder = [...bookmarks.nodes.values()].find((n) => n.title === 'tail-scale.ts.net');
    expect(folder).toBeDefined();
    expect(folder!.parentId).toBe(OTHER_ROOT_ID);
    const urls = [...bookmarks.nodes.values()].filter((n) => n.url).map((n) => n.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://pi.tail-scale.ts.net/',
        'https://starforge.tail-scale.ts.net/',
        'http://grafana.tail-scale.ts.net:3000/',
        'https://paperless.tail-scale.ts.net/',
      ]),
    );
  });

  it('the steady state costs zero writes on the very next run (content-hash short circuit)', async () => {
    const bookmarks = fakeBookmarksAPI([{ id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false }]);
    const first = await runReconcile(baseInputs({ bookmarks }));
    expect(first.status).toBe('ok');

    const createSpy = vi.spyOn(bookmarks, 'create');
    const second = await runReconcile(baseInputs({ bookmarks, now: 2_000_000 }));
    expect(second).toMatchObject({ status: 'ok', created: 0, updated: 0, removed: 0 });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('threads firstMissingAt through two runs to confirm a lagged delete', async () => {
    const bookmarks = fakeBookmarksAPI([{ id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false }]);
    await runReconcile(baseInputs({ bookmarks, now: 1_000_000 }));

    // Disable services so the two service bookmarks become "missing".
    const lagMs = 30 * 60_000;
    const run2 = await runReconcile(
      baseInputs({ bookmarks, toggles: { devicesEnabled: true, servicesEnabled: false }, now: 1_100_000, deleteLagMs: lagMs }),
    );
    expect(run2.status).toBe('ok');
    if (run2.status !== 'ok') return;
    expect(run2.removed).toBe(0); // first poll to notice: no delete yet
    expect(Object.keys(run2.firstMissingAt).sort()).toEqual([
      'http://grafana.tail-scale.ts.net:3000/',
      'https://paperless.tail-scale.ts.net/',
    ]);

    const run3 = await runReconcile(
      baseInputs({
        bookmarks,
        toggles: { devicesEnabled: true, servicesEnabled: false },
        now: 1_100_000 + lagMs, // exactly one interval later
        deleteLagMs: lagMs,
        firstMissingAt: run2.firstMissingAt,
      }),
    );
    expect(run3.status).toBe('ok');
    if (run3.status !== 'ok') return;
    expect(run3.removed).toBe(2);
    expect(run3.firstMissingAt).toEqual({});
  });

  it('keeps the folder and applies no writes when locating a duplicate whose removal is suppressed by an unknown slice', async () => {
    // Two candidate managed folders already exist (independent-creation
    // hazard). Services fail this run, so rule 4's dedupe delete must be
    // suppressed too (planner.ts's ruling) — prove that end to end
    // rather than only at the planner unit level.
    const bookmarks = fakeBookmarksAPI([
      { id: OTHER_ROOT_ID, title: 'Other Bookmarks', syncing: false },
      { id: 'f1', parentId: OTHER_ROOT_ID, title: 'tail-scale.ts.net', dateAdded: 100, syncing: false },
      { id: 'f2', parentId: OTHER_ROOT_ID, title: 'tail-scale.ts.net', dateAdded: 200, syncing: false },
    ]);
    const outcome = await runReconcile(baseInputs({ bookmarks, fetchImpl: fakeFetch(['services']) }));
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.removed).toBe(0);
    // Both folders still present — the loser was not deleted.
    expect(bookmarks.nodes.has('f1')).toBe(true);
    expect(bookmarks.nodes.has('f2')).toBe(true);
  });
});
