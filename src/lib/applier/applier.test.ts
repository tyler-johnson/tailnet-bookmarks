import { describe, expect, it, vi } from 'vitest';
import { applyOps, type ApplierContext, type BookmarksAPI } from './applier';
import type { Op } from '../planner';
import type { Browser } from 'wxt/browser';

type Node = Browser.bookmarks.BookmarkTreeNode;

/** An in-memory fake of the slice of `browser.bookmarks` the applier
 * uses, so these tests run with no browser/WXT runtime — same pattern as
 * src/lib/tailscale/session-store.test.ts's fake SessionKV. */
function fakeBookmarksAPI(seed: Node[] = []): BookmarksAPI & { nodes: Map<string, Node> } {
  const nodes = new Map<string, Node>(seed.map((n) => [n.id, n]));
  let nextId = 1000;

  const api: BookmarksAPI & { nodes: Map<string, Node> } = {
    nodes,
    async getTree() {
      return [{ id: '0', title: 'root', children: [...nodes.values()] } as Node];
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
      for (const n of [...nodes.values()]) {
        if (n.parentId === id) nodes.delete(n.id);
      }
    },
  };
  return api;
}

function ctx(overrides: Partial<ApplierContext> & { bookmarks: BookmarksAPI }): ApplierContext {
  return { parentId: 'parent-1', folderName: 'tailnet.ts.net', ...overrides };
}

describe('applyOps', () => {
  it('does nothing and returns zero counts for an empty op list', async () => {
    const bookmarks = fakeBookmarksAPI();
    const result = await applyOps([], ctx({ bookmarks, folderId: 'folder-1' }));
    expect(result).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('createFolder creates the folder under parentId and becomes the target for subsequent creates', async () => {
    const bookmarks = fakeBookmarksAPI();
    const ops: Op[] = [
      { type: 'createFolder' },
      { type: 'createBookmark', url: 'https://a.ts.net/', title: 'a' },
    ];
    const result = await applyOps(ops, ctx({ bookmarks }));
    expect(result).toEqual({ created: 1, updated: 0, removed: 0 });

    const created = [...bookmarks.nodes.values()];
    const folder = created.find((n) => n.title === 'tailnet.ts.net');
    expect(folder).toBeDefined();
    expect(folder!.parentId).toBe('parent-1');
    const bookmark = created.find((n) => n.url === 'https://a.ts.net/');
    expect(bookmark!.parentId).toBe(folder!.id);
  });

  it('createBookmark targets the pre-existing folderId when no createFolder op is present', async () => {
    const bookmarks = fakeBookmarksAPI();
    const ops: Op[] = [{ type: 'createBookmark', url: 'https://a.ts.net/', title: 'a' }];
    await applyOps(ops, ctx({ bookmarks, folderId: 'existing-folder' }));
    const bookmark = [...bookmarks.nodes.values()].find((n) => n.url === 'https://a.ts.net/');
    expect(bookmark!.parentId).toBe('existing-folder');
  });

  it('throws if createBookmark has no target folder at all (caller bug, not a race)', async () => {
    const bookmarks = fakeBookmarksAPI();
    const ops: Op[] = [{ type: 'createBookmark', url: 'https://a.ts.net/', title: 'a' }];
    await expect(applyOps(ops, ctx({ bookmarks }))).rejects.toThrow(/no target folder/);
  });

  it('removeDuplicateFolder removes the folder (recursively) and counts toward removed', async () => {
    const bookmarks = fakeBookmarksAPI([
      { id: 'loser', parentId: 'parent-1', title: 'tailnet.ts.net', dateAdded: 1, syncing: false },
      { id: 'child', parentId: 'loser', url: 'https://a.ts.net/', title: 'a', dateAdded: 1, syncing: false },
    ]);
    const ops: Op[] = [{ type: 'removeDuplicateFolder', folderId: 'loser' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result.removed).toBe(1);
    expect(bookmarks.nodes.has('loser')).toBe(false);
    expect(bookmarks.nodes.has('child')).toBe(false);
  });

  it('removeBookmark removes by id and counts toward removed', async () => {
    const bookmarks = fakeBookmarksAPI([
      { id: 'b1', parentId: 'survivor', url: 'https://a.ts.net/', title: 'a', dateAdded: 1, syncing: false },
    ]);
    const ops: Op[] = [{ type: 'removeBookmark', id: 'b1', url: 'https://a.ts.net/' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result.removed).toBe(1);
    expect(bookmarks.nodes.has('b1')).toBe(false);
  });

  it('updateTitle updates by id and counts toward updated', async () => {
    const bookmarks = fakeBookmarksAPI([
      { id: 'b1', parentId: 'survivor', url: 'https://a.ts.net/', title: 'old', dateAdded: 1, syncing: false },
    ]);
    const ops: Op[] = [{ type: 'updateTitle', id: 'b1', url: 'https://a.ts.net/', title: 'new' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result.updated).toBe(1);
    expect(bookmarks.nodes.get('b1')!.title).toBe('new');
  });

  it('a removeBookmark whose target already vanished (another machine got there first) is swallowed, not counted, not thrown', async () => {
    const bookmarks = fakeBookmarksAPI(); // nothing exists
    const ops: Op[] = [{ type: 'removeBookmark', id: 'already-gone', url: 'https://a.ts.net/' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('an updateTitle whose target already vanished is swallowed, not counted, not thrown', async () => {
    const bookmarks = fakeBookmarksAPI();
    const ops: Op[] = [{ type: 'updateTitle', id: 'already-gone', url: 'https://a.ts.net/', title: 'x' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('a removeDuplicateFolder whose target already vanished is swallowed, not counted, not thrown', async () => {
    const bookmarks = fakeBookmarksAPI();
    const ops: Op[] = [{ type: 'removeDuplicateFolder', folderId: 'already-gone' }];
    const result = await applyOps(ops, ctx({ bookmarks, folderId: 'survivor' }));
    expect(result).toEqual({ created: 0, updated: 0, removed: 0 });
  });

  it('executes op kinds in order: folder ops, then removes, then creates, then updates — regardless of array order', async () => {
    const bookmarks = fakeBookmarksAPI([
      { id: 'stale', parentId: 'survivor', url: 'https://stale.ts.net/', title: 'stale', dateAdded: 1, syncing: false },
      { id: 'retitle', parentId: 'survivor', url: 'https://b.ts.net/', title: 'old', dateAdded: 1, syncing: false },
    ]);
    const calls: string[] = [];
    const spied: BookmarksAPI = {
      ...bookmarks,
      create: vi.fn((b) => {
        calls.push('create');
        return bookmarks.create(b);
      }),
      remove: vi.fn((id) => {
        calls.push('remove');
        return bookmarks.remove(id);
      }),
      update: vi.fn((id, c) => {
        calls.push('update');
        return bookmarks.update(id, c);
      }),
    };
    // Deliberately out of the "natural" order to prove grouping doesn't
    // depend on array position.
    const ops: Op[] = [
      { type: 'updateTitle', id: 'retitle', url: 'https://b.ts.net/', title: 'new' },
      { type: 'createBookmark', url: 'https://c.ts.net/', title: 'c' },
      { type: 'removeBookmark', id: 'stale', url: 'https://stale.ts.net/' },
    ];
    await applyOps(ops, ctx({ bookmarks: spied, folderId: 'survivor' }));
    expect(calls).toEqual(['remove', 'create', 'update']);
  });

  it('runs createFolder before removeDuplicateFolder, and both before any bookmark op', async () => {
    const bookmarks = fakeBookmarksAPI([
      { id: 'loser', parentId: 'parent-1', title: 'tailnet.ts.net', dateAdded: 1, syncing: false },
    ]);
    const calls: string[] = [];
    const spied: BookmarksAPI = {
      ...bookmarks,
      create: vi.fn((b) => {
        calls.push('create');
        return bookmarks.create(b);
      }),
      removeTree: vi.fn((id) => {
        calls.push('removeTree');
        return bookmarks.removeTree(id);
      }),
    };
    const ops: Op[] = [
      { type: 'createFolder' },
      { type: 'removeDuplicateFolder', folderId: 'loser' },
      { type: 'createBookmark', url: 'https://a.ts.net/', title: 'a' },
    ];
    await applyOps(ops, ctx({ bookmarks: spied }));
    expect(calls).toEqual(['create', 'removeTree', 'create']);
  });
});
