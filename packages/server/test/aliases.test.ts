import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { FailoverService } from '../src/library/failover.js';
import { fetchTitleAliases } from '../src/library/anilist.js';
import { LibraryStore } from '../src/library/store.js';
import { registerLibraryRoutes } from '../src/routes/library.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { EventBus } from '../src/ws.js';

/** AniList Response-like object for the stubbed global fetch. */
const jsonResponse = (payload: unknown, ok = true, status = 200) => ({ ok, status, json: async () => payload });
const anilistMedia = (english: string | null, romaji: string | null, synonyms: string[] = []) => ({
    title: { romaji, english, native: null },
    synonyms
});

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let app: ReturnType<typeof Fastify>;
let entryId = 0;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-aliases-'));
    database = new Database(tmpDir);
    const settings = {
        dataDirectory: path.join(tmpDir, 'downloads'),
        directoryLayout: 'source' as const,
        chapterFormat: 'cbz' as const,
        parallelSources: 1,
        concurrencyPerSource: 1,
        throttleMs: 0
    };
    // the alternative source answers only when searched by the alias — the
    // current title (or an alias-less crawl) finds nothing on it
    const adapters = {
        s1: { label: 'Source One', searchMangas: async () => [], getChapters: async () => [] },
        s2: {
            label: 'Source Two',
            searchMangas: async (query: string) => (query === 'Other Name' ? [{ id: 'x1', title: 'Other Name' }] : []),
            getChapters: async () => Array.from({ length: 30 }, (_, index) => ({ id: `x${index + 1}`, title: `Ch.${index + 1}`, language: 'en' }))
        }
    };
    const registry = { get: async (id: string) => adapters[id], list: async () => [] };
    store = new LibraryStore({ db: database, registry: registry as never, queueSettings: settings });
    const events = new EventBus();
    const queue = new DownloadQueue({ db: database, registry: registry as never, events, settings });
    const scheduler = new Scheduler({ db: database, store, queue, events });
    const failover = new FailoverService({
        registry: registry as never,
        store,
        listSources: async () => [
            { id: 's1', label: 'Source One', tags: ['English'], kind: 'native' },
            { id: 's2', label: 'Source Two', tags: ['English'], kind: 'native' }
        ],
        getPreferredLanguages: () => ['en']
    });
    app = Fastify();
    registerLibraryRoutes(app, store, scheduler, queue, events, failover);
    await app.ready();
    const { entry } = await store.addEntry({ sourceId: 's1', mangaId: 'm1', title: 'Solo Leveling', backlog: 'ignore' });
    entryId = entry.id;
});

afterAll(async () => {
    await app.close();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('alias storage (setAliases)', () => {
    it('trims, dedupes case-insensitively and drops the current title', () => {
        const kept = store.setAliases(entryId, ['  Other Name  ', 'other name', 'solo leveling', 'x', '', 'ORV']);
        expect(kept).toEqual(['Other Name', 'ORV']);
        expect(store.getEntry(entryId)?.aliases).toEqual(['Other Name', 'ORV']);
    });

    it('caps the list at 10 names and clears with an empty list', () => {
        expect(store.setAliases(entryId, Array.from({ length: 15 }, (_, index) => `Alias ${index}`))).toHaveLength(10);
        expect(store.setAliases(entryId, [])).toEqual([]);
        expect(store.getEntry(entryId)?.aliases).toBeUndefined();
    });

    it('throws for a missing entry', () => {
        expect(() => store.setAliases(999_999, ['Whatever'])).toThrow(/not found/i);
    });
});

describe('AniList client (fetchTitleAliases)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns every known title of the best-matching media', async () => {
        const fetchMock = vi.fn(async () =>
            jsonResponse({
                data: {
                    Page: {
                        media: [
                            anilistMedia(null, 'Unrelated Romaji', ['Noise']),
                            anilistMedia('Solo Leveling', 'Na Honjaman Level Up', ['I Level Up Alone'])
                        ]
                    }
                }
            })
        );
        vi.stubGlobal('fetch', fetchMock);
        expect(await fetchTitleAliases('Solo Leveling')).toEqual(['Solo Leveling', 'Na Honjaman Level Up', 'I Level Up Alone']);
        // GraphQL POST against the documented endpoint
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://graphql.anilist.co');
        expect(init.method).toBe('POST');
    });

    it('returns nothing when AniList has no convincing match', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ data: { Page: { media: [anilistMedia(null, 'Totally Different Series')] } } }));
        expect(await fetchTitleAliases('Solo Leveling')).toEqual([]);
    });

    it('returns nothing on an empty result page', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ data: { Page: { media: [] } } }));
        expect(await fetchTitleAliases('Solo Leveling')).toEqual([]);
    });

    it('throws on HTTP failure so the route can surface the error', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ message: 'Too Many Requests.' }, false, 429));
        await expect(fetchTitleAliases('Solo Leveling')).rejects.toThrow('AniList HTTP 429');
    });
});

describe('alias routes', () => {
    it('PUT replaces the alias list', async () => {
        const response = await app.inject({ method: 'PUT', url: `/api/library/${entryId}/aliases`, payload: { aliases: ['ORV'] } });
        expect(response.statusCode).toBe(200);
        expect(response.json().entry.aliases).toEqual(['ORV']);
    });

    it('PUT validates the body shape', async () => {
        const response = await app.inject({ method: 'PUT', url: `/api/library/${entryId}/aliases`, payload: { aliases: 'ORV' } });
        expect(response.statusCode).toBe(400);
    });

    it('PUT 404s for a missing entry', async () => {
        const response = await app.inject({ method: 'PUT', url: '/api/library/999999/aliases', payload: { aliases: [] } });
        expect(response.statusCode).toBe(404);
    });

    it('POST fetch merges the AniList titles into the existing aliases', async () => {
        vi.stubGlobal(
            'fetch',
            async () => jsonResponse({ data: { Page: { media: [anilistMedia('Solo Leveling', 'Na Honjaman Level Up', ['I Level Up Alone'])] } } })
        );
        const response = await app.inject({ method: 'POST', url: `/api/library/${entryId}/aliases/fetch` });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.fetched).toEqual(['Solo Leveling', 'Na Honjaman Level Up', 'I Level Up Alone']);
        // merged with the PUT list; the current title itself is dropped
        expect(body.entry.aliases).toEqual(['ORV', 'Na Honjaman Level Up', 'I Level Up Alone']);
        vi.unstubAllGlobals();
    });

    it('GET alternatives auto-fetches AniList names when no source is found and retries the crawl', async () => {
        store.setAliases(entryId, []);
        vi.stubGlobal(
            'fetch',
            async () => jsonResponse({ data: { Page: { media: [anilistMedia('Solo Leveling', 'Na Honjaman Level Up', ['Other Name'])] } } })
        );
        const response = await app.inject({ method: 'GET', url: `/api/library/${entryId}/alternatives` });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        // first crawl (title only) missed; the retry through 'Other Name' found s2
        expect(body.alternatives.map((a: { sourceId: string }) => a.sourceId)).toEqual(['s2']);
        expect(body.autoAliases).toEqual(['Na Honjaman Level Up', 'Other Name']);
        expect(store.getEntry(entryId)?.aliases).toEqual(['Na Honjaman Level Up', 'Other Name']);
        vi.unstubAllGlobals();
    });

    it('GET alternatives reports nothing new when AniList has no convincing match', async () => {
        store.setAliases(entryId, []);
        vi.stubGlobal('fetch', async () => jsonResponse({ data: { Page: { media: [anilistMedia(null, 'Totally Different Series')] } } }));
        const response = await app.inject({ method: 'GET', url: `/api/library/${entryId}/alternatives` });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.alternatives).toEqual([]);
        expect(body.autoAliases).toBeUndefined();
        expect(store.getEntry(entryId)?.aliases).toBeUndefined();
        vi.unstubAllGlobals();
    });
});
