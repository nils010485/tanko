import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SourceAdapter } from '@tanko/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CachedSourceAdapter } from '../src/cache/cached-adapter.js';
import { SqliteCacheStore } from '../src/cache/sqlite-store.js';
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
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteCacheStore', () => {
    it('stores and returns values', async () => {
        await store.set('k1', { a: 1 }, 60);
        expect(await store.get('k1')).toEqual({ a: 1 });
    });

    it('returns undefined for missing keys', async () => {
        expect(await store.get('nope')).toBeUndefined();
    });

    it('expires entries after the TTL', async () => {
        await store.set('k2', 'value', -1); // already expired
        expect(await store.get('k2')).toBeUndefined();
    });

    it('overwrites existing keys', async () => {
        await store.set('k3', 1, 60);
        await store.set('k3', 2, 60);
        expect(await store.get('k3')).toBe(2);
    });

    it('deletes keys', async () => {
        await store.set('k4', 'x', 60);
        await store.delete('k4');
        expect(await store.get('k4')).toBeUndefined();
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
    it('does not cache native searches (site search endpoints are fast)', async () => {
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
        await adapter.searchMangas('a');
        await adapter.searchMangas('b');
        expect(calls.search).toBe(2);
    });
});
