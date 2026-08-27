import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import type { SourceInfo } from '../src/import/service.js';
import { classifyFailure, FailoverService } from '../src/library/failover.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let detectionEnabled = false;

/** Adapter factory: chapters numbered 1..count in English. */
const adapterWith = (count: number, title: string) => ({
    label: title,
    searchMangas: async () => [{ id: 'm1', title }],
    getChapters: async () => Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}`, title: `Chapter ${index + 1}`, language: 'en' }))
});

const adapters: Record<string, ReturnType<typeof adapterWith>> = {
    current: adapterWith(8, 'Starved Series'),
    richer: adapterWith(120, 'Starved Series'),
    poorer: adapterWith(3, 'Starved Series'),
    stranger: adapterWith(90, 'Starved Series — Official')
};

const sourceInfos: SourceInfo[] = [
    { id: 'current', label: 'Current', tags: ['English'], kind: 'native' },
    { id: 'richer', label: 'Richer', tags: ['English'], kind: 'native' },
    { id: 'poorer', label: 'Poorer', tags: ['English'], kind: 'native' },
    { id: 'stranger', label: 'Stranger', tags: ['English'], kind: 'legacy' }
];

const registry = {
    get: async (id: string) => adapters[id],
    list: async () => []
};

let failover: FailoverService;
let entryId = 0;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-failover-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
        db: database,
        registry: registry as never,
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'cbz',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
    failover = new FailoverService({
        registry: registry as never,
        store,
        listSources: async () => sourceInfos,
        getPreferredLanguages: () => ['en'],
        isDetectionEnabled: () => detectionEnabled
    });
    const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'm1', title: 'Starved Series', backlog: 'ignore' });
    entryId = entry.id;
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('failure classification (classifyFailure)', () => {
    it('treats the MangaHere war.jpg placeholder as content-side removal', () => {
        expect(classifyFailure('MangaHere: page list failed (source serves no images for this title (removed or licensed on MangaHere/MangaFox))')).toBe('content');
    });
    it('keeps treating CDN/network noise as infra', () => {
        expect(classifyFailure('Failed to download page "https://zjcdn.mangahere.org/x.jpg": non-image page (text/plain, 0 bytes)')).toBe('infra');
        expect(classifyFailure('HTTP 503')).toBe('infra');
        expect(classifyFailure(null)).toBe('infra');
    });
});

describe('manual source picker (listAlternatives)', () => {
    it('lists one candidate per source, sorted by chapter count', async () => {
        const alternatives = await failover.listAlternatives({ id: entryId, sourceId: 'current', title: 'Starved Series' });
        // the current source is excluded; one row per remaining source
        expect(alternatives.map(a => a.sourceId)).toEqual(['richer', 'stranger', 'poorer']);
        expect(alternatives[0].chapterCount).toBe(120);
        expect(alternatives[0].score ?? 0).toBeGreaterThan(0.9);
    });

    it('goes deeper when a perfect match carries no preferred-language chapters', async () => {
        // decoy = MangaDex-like: native, perfect title match, only foreign-language
        // rips; rescue = aggregator carrying the title in the preferred language
        const localAdapters: Record<string, unknown> = {
            decoy: {
                searchMangas: async () => [{ id: 'd1', title: 'Starved Series' }],
                getChapters: async () => [{ id: 'c1', title: 'Ch.1', language: 'pl' }]
            },
            rescue: {
                searchMangas: async () => [{ id: 'r1', title: 'Starved Series' }],
                getChapters: async () => Array.from({ length: 9 }, (_, index) => ({ id: `r${index}`, title: `Ch.${index + 1}`, language: 'en' }))
            }
        };
        const localFailover = new FailoverService({
            registry: { get: async (id: string) => localAdapters[id] } as never,
            store,
            listSources: async () => [
                { id: 'decoy', label: 'Decoy', tags: ['English'], kind: 'native' },
                { id: 'rescue', label: 'Rescue', tags: ['English'], kind: 'legacy' }
            ],
            getPreferredLanguages: () => ['en']
        });
        const alternatives = await localFailover.listAlternatives({ id: entryId, sourceId: 'current', title: 'Starved Series' });
        expect(alternatives.map(a => a.sourceId)).toEqual(['rescue']);
        expect(alternatives[0].chapterCount).toBe(9);
    });
});

describe('opt-in starved-source detection (suggestIfIncomplete)', () => {
    it('does nothing while the setting is off', async () => {
        detectionEnabled = false;
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('skipped');
        expect(store.getEntry(entryId)?.migrationSuggestion).toBeUndefined();
    });

    it('suggests a source with at least twice the chapters when enabled', async () => {
        detectionEnabled = true;
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('suggested');
        const suggestion = store.getEntry(entryId)?.migrationSuggestion;
        expect(suggestion?.sourceId).toBe('richer');
        expect(suggestion?.chapterCount ?? 0).toBeGreaterThanOrEqual(16);
    });

    it('skips entries that already have a pending suggestion', async () => {
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('skipped');
    });

    it('skips entries with more chapters than the threshold', async () => {
        store.setMigrationSuggestion(entryId, null);
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 42)).toBe('skipped');
        expect(store.getEntry(entryId)?.migrationSuggestion).toBeUndefined();
    });

    it('does not re-suggest a target the user dismissed (a different source is fine)', async () => {
        store.setMigrationSuggestion(entryId, null);
        // the user rejected the richer source: only that exact target is barred
        store.dismissMigrationSuggestion(entryId, { sourceId: 'richer', sourceLabel: 'Richer', mangaId: 'm1', mangaTitle: 'Starved Series', score: 1 });
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('suggested');
        expect(store.getEntry(entryId)?.migrationSuggestion?.sourceId).toBe('stranger');
    });
});

describe('opt-in stalled-source detection (suggestIfStalled)', () => {
    let stalledEnabled = false;
    let stalledFailover: FailoverService;
    let stalledId = 0;

    beforeAll(async () => {
        // own adapters: a long series stalled at ch. 150, alternatives at
        // 152 (enough), 151 (one short) and 12 (way behind)
        const adapters = {
            current: adapterWith(150, 'Stalled Series'),
            ahead: adapterWith(152, 'Stalled Series'),
            barely: adapterWith(151, 'Stalled Series'),
            poorer: adapterWith(12, 'Stalled Series')
        };
        stalledFailover = new FailoverService({
            registry: { get: async (id: string) => adapters[id], list: async () => [] } as never,
            store,
            listSources: async () => [
                { id: 'current', label: 'Current', tags: ['English'], kind: 'native' },
                { id: 'ahead', label: 'Ahead', tags: ['English'], kind: 'native' },
                { id: 'barely', label: 'Barely', tags: ['English'], kind: 'native' },
                { id: 'poorer', label: 'Poorer', tags: ['English'], kind: 'native' }
            ],
            getPreferredLanguages: () => ['en'],
            isStalledDetectionEnabled: () => stalledEnabled
        });
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'sm', title: 'Stalled Series', backlog: 'ignore' });
        stalledId = entry.id;
    });

    it("returns 'skipped' and stores nothing while the setting is off", async () => {
        expect(await stalledFailover.suggestIfStalled({ id: stalledId, sourceId: 'current', title: 'Stalled Series' }, 150)).toBe('skipped');
        expect(store.getEntry(stalledId)?.migrationSuggestion).toBeUndefined();
    });

    it('suggests a source with at least two more chapters — not twice as many', async () => {
        stalledEnabled = true;
        expect(await stalledFailover.suggestIfStalled({ id: stalledId, sourceId: 'current', title: 'Stalled Series' }, 150)).toBe('suggested');
        const suggestion = store.getEntry(stalledId)?.migrationSuggestion;
        expect(suggestion?.sourceId).toBe('ahead'); // 152 = 150 + 2; the starved 2× rule would demand 300
        expect(suggestion?.chapterCount).toBe(152);
    });

    it('never migrates by itself: the entry stays on its current source', () => {
        const entry = store.getEntry(stalledId);
        expect(entry?.sourceId).toBe('current');
        expect(entry?.canRollbackMigration).toBe(false);
    });

    it("returns 'skipped' while a suggestion is pending", async () => {
        expect(await stalledFailover.suggestIfStalled({ id: stalledId, sourceId: 'current', title: 'Stalled Series' }, 150)).toBe('skipped');
    });

    it("returns 'miss' when the best source is only one chapter ahead", async () => {
        store.setMigrationSuggestion(stalledId, null);
        // the user rejected the only source with ≥ +2 chapters…
        store.dismissMigrationSuggestion(stalledId, { sourceId: 'ahead', sourceLabel: 'Ahead', mangaId: 'm1', mangaTitle: 'Stalled Series', score: 1 });
        // …leaving barely (151 = 150 + 1): a real probe, but not enough chapters
        expect(await stalledFailover.suggestIfStalled({ id: stalledId, sourceId: 'current', title: 'Stalled Series' }, 150)).toBe('miss');
        expect(store.getEntry(stalledId)?.migrationSuggestion).toBeUndefined();
    });
});
