import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SourceAdapter } from '@tanko/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CachedSourceAdapter } from '../src/cache/cached-adapter.js';
import { SqliteCacheStore } from '../src/cache/sqlite-store.js';
import { TieredCacheStore } from '../src/cache/tiered-store.js';
import { Database } from '../src/db.js';

let tmpDir: string;
let database: Database;
let store: SqliteCacheStore;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-cache-'));
    database = new Database(tmpDir);
    store = new SqliteCacheStore(database);
});

afterEach(() => {
    store.dispose();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteCacheStore', () => {
    it('stores, overwrites and deletes values', async () => {
        expect(await store.get('missing')).toBeUndefined();
        await store.set('k1', { a: 1 }, 60);
        expect(await store.get('k1')).toEqual({ a: 1 });
        await store.set('k1', 2, 60);
        expect(await store.get('k1')).toBe(2);
        await store.delete('k1');
        expect(await store.get('k1')).toBeUndefined();
    });

    it('expires entries after the TTL', async () => {
        await store.set('k2', 'value', -1); // already expired
        expect(await store.get('k2')).toBeUndefined();
    });

    it('clears every entry and returns the removed count', async () => {
        await store.set('a', 1, 60);
        await store.set('b', 2, 60);
        expect(await store.clear()).toBe(2);
        expect(await store.get('a')).toBeUndefined();
        expect(await store.get('b')).toBeUndefined();
    });

    it('purges expired rows on the interval, not on every set', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            const timed = new SqliteCacheStore(database);
            const rowCount = () => (database.db.prepare('SELECT COUNT(*) AS n FROM cache').get() as { n: number }).n;

            await timed.set('stale', 'value', 1);
            vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
            await timed.set('fresh', 'value', 3600);
            expect(rowCount()).toBe(2);

            vi.advanceTimersByTime(5 * 60 * 1000);
            expect(rowCount()).toBe(1);
            expect(database.db.prepare('SELECT key FROM cache').get()).toEqual({ key: 'fresh' });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('TieredCacheStore', () => {
    let tiered: TieredCacheStore;

    beforeEach(() => {
        tiered = new TieredCacheStore(store);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('serves repeated reads from memory without re-reading SQLite', async () => {
        const innerRead = vi.spyOn(store, 'getWithExpiry');
        await tiered.set('catalog', [{ id: 'm1', title: 'Solo Leveling' }], 60);

        expect(await tiered.get('catalog')).toEqual([{ id: 'm1', title: 'Solo Leveling' }]);
        expect(await tiered.get('catalog')).toEqual([{ id: 'm1', title: 'Solo Leveling' }]);
        expect(innerRead).toHaveBeenCalledTimes(0);
    });

    it('parses a persisted blob once when it is not in memory', async () => {
        await store.set('catalog', [{ id: 'm1' }, { id: 'm2' }], 60);
        const fresh = new TieredCacheStore(store);
        const parse = vi.spyOn(JSON, 'parse');

        expect(await fresh.get('catalog')).toEqual([{ id: 'm1' }, { id: 'm2' }]);
        expect(await fresh.get('catalog')).toEqual([{ id: 'm1' }, { id: 'm2' }]);
        expect(parse).toHaveBeenCalledTimes(1);
    });

    it('honors the TTL of memory entries', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            const timed = new TieredCacheStore(store);
            await timed.set('short', 'value', 5);
            expect(await timed.get('short')).toBe('value');

            vi.setSystemTime(new Date('2026-01-01T00:00:06Z'));
            expect(await timed.get('short')).toBeUndefined();
            expect(await timed.get('short')).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('invalidates memory on set, delete and clear', async () => {
        await tiered.set('k', 1, 60);
        expect(await tiered.get('k')).toBe(1);

        await tiered.set('k', 2, 60);
        expect(await tiered.get('k')).toBe(2);

        await tiered.delete('k');
        expect(await tiered.get('k')).toBeUndefined();

        await tiered.set('a', 1, 60);
        await tiered.set('b', 2, 60);
        expect(await tiered.get('a')).toBe(1);
        expect(await tiered.get('b')).toBe(2);
        expect(await tiered.clear()).toBe(2);
        expect(await tiered.get('a')).toBeUndefined();
        expect(await tiered.get('b')).toBeUndefined();
    });

    it('reads through to SQLite when the memory tier is empty', async () => {
        await store.set('k', { a: 1 }, 60);
        expect(await tiered.get('k')).toEqual({ a: 1 });
        expect(await store.get('k')).toEqual({ a: 1 });
        expect(await tiered.get('missing')).toBeUndefined();
    });
});

function fakeLegacyAdapter(calls: { search: number; chapters: number }): SourceAdapter {
    return {
        id: 'legacy-x',
        label: 'Legacy X',
        tags: [],
        kind: 'legacy',
        url: 'https://x.test',
        initialize: async () => undefined,
        searchMangas: async (query: string) => {
            calls.search++;
            return [
                { id: 'm1', title: 'Solo Leveling' },
                { id: 'm2', title: 'Tower of God' }
            ].filter(m => m.title.toLowerCase().includes(query.toLowerCase()));
        },
        getChapters: async () => {
            calls.chapters++;
            return [{ id: 'c1', title: 'Chapter 1' }];
        },
        getPages: async () => [],
        checkHealth: async () => ({ ok: true, latencyMs: 1 })
    };
}

describe('CachedSourceAdapter (legacy)', () => {
    it('caches the manga list and filters locally', async () => {
        const calls = { search: 0, chapters: 0 };
        const adapter = new CachedSourceAdapter(fakeLegacyAdapter(calls), store);

        const first = await adapter.searchMangas('solo');
        expect(first.map(m => m.id)).toEqual(['m1']);
        expect(calls.search).toBe(1);

        // second search hits the cache (no new upstream call)
        const second = await adapter.searchMangas('tower');
        expect(second.map(m => m.id)).toEqual(['m2']);
        expect(calls.search).toBe(1);
    });

    it('caches chapter lists', async () => {
        const calls = { search: 0, chapters: 0 };
        const adapter = new CachedSourceAdapter(fakeLegacyAdapter(calls), store);

        await adapter.getChapters({ id: 'm1', title: 'Solo Leveling' });
        await adapter.getChapters({ id: 'm1', title: 'Solo Leveling' });
        expect(calls.chapters).toBe(1);
    });
});

describe('CachedSourceAdapter (native)', () => {
    it('caches native search results for the same query', async () => {
        const calls = { search: 0 };
        const native: SourceAdapter = {
            id: 'native-x',
            label: 'Native X',
            tags: [],
            kind: 'native',
            url: 'https://n.test',
            initialize: async () => undefined,
            searchMangas: async () => {
                calls.search++;
                return [{ id: 'n1', title: 'One Piece' }];
            },
            getChapters: async () => [],
            getPages: async () => [],
            checkHealth: async () => ({ ok: true, latencyMs: 1 })
        };
        const adapter = new CachedSourceAdapter(native, store);
        await adapter.searchMangas('one');
        await adapter.searchMangas('one'); // same (normalized) query: cache hit
        expect(calls.search).toBe(1);
        await adapter.searchMangas('piece'); // different query: different key
        expect(calls.search).toBe(2);
    });

    it('keys native search caching on the requested languages', async () => {
        const calls: string[][] = [];
        const native: SourceAdapter = {
            id: 'native-x',
            label: 'Native X',
            tags: [],
            kind: 'native',
            url: 'https://n.test',
            initialize: async () => undefined,
            searchMangas: async (_query, options) => {
                calls.push(options?.languages ?? []);
                return [{ id: 'n1', title: 'One Piece' }];
            },
            getChapters: async () => [],
            getPages: async () => [],
            checkHealth: async () => ({ ok: true, latencyMs: 1 })
        };
        const adapter = new CachedSourceAdapter(native, store);
        await adapter.searchMangas('one', { languages: ['en'] });
        await adapter.searchMangas('one', { languages: ['en'] }); // same languages: cache hit
        expect(calls).toHaveLength(1);
        await adapter.searchMangas('one', { languages: ['fr'] }); // different filter: different key
        expect(calls).toEqual([['en'], ['fr']]);
    });

    it('keys chapter-list caching on the requested languages', async () => {
        const calls = { chapters: 0 };
        const native: SourceAdapter = {
            id: 'native-x',
            label: 'Native X',
            tags: [],
            kind: 'native',
            url: 'https://n.test',
            initialize: async () => undefined,
            searchMangas: async () => [],
            getChapters: async (_manga, options) => {
                calls.chapters++;
                return [{ id: 'c1', title: 'Chapter 1', language: options?.languages?.[0] ?? 'all' }];
            },
            getPages: async () => [],
            checkHealth: async () => ({ ok: true, latencyMs: 1 })
        };
        const adapter = new CachedSourceAdapter(native, store);
        const manga = { id: 'm1', title: 'Berserk' };

        await adapter.getChapters(manga, { languages: ['en'] });
        await adapter.getChapters(manga, { languages: ['en'] }); // same languages: cache hit
        expect(calls.chapters).toBe(1);

        await adapter.getChapters(manga, { languages: ['fr'] }); // different filter: different key
        expect(calls.chapters).toBe(2);

        await adapter.getChapters(manga); // unfiltered is its own key too
        expect(calls.chapters).toBe(3);
    });

    it('does not cache empty native results (likely a failure)', async () => {
        const calls = { search: 0 };
        const native: SourceAdapter = {
            id: 'native-x',
            label: 'Native X',
            tags: [],
            kind: 'native',
            url: 'https://n.test',
            initialize: async () => undefined,
            searchMangas: async () => {
                calls.search++;
                return [];
            },
            getChapters: async () => [],
            getPages: async () => [],
            checkHealth: async () => ({ ok: true, latencyMs: 1 })
        };
        const adapter = new CachedSourceAdapter(native, store);
        await adapter.searchMangas('x');
        await adapter.searchMangas('x');
        expect(calls.search).toBe(2);
    });
});
