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

/** Adapter factory: chapters numbered 1..count in English, one working page. */
const adapterWith = (count: number, title: string) => ({
    label: title,
    searchMangas: async () => [{ id: 'm1', title }],
    getChapters: async () => Array.from({ length: count }, (_, index) => ({ id: `c${index + 1}`, title: `Chapter ${index + 1}`, language: 'en' })),
    getPages: async () => ['https://img.example/p1.jpg']
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
        expect(classifyFailure('MangaHere: page list failed (source serves no images for this title (removed or licensed on MangaHere/MangaFox))')).toBe(
            'content'
        );
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
        // wave 1 must be full of natives so the crawl early-exits on the decoy
        // (MangaDex-like: perfect title, foreign-language rips only); the
        // rescue aggregator (legacy, preferred-language chapters) can then
        // only be reached by round 2's exclusion set — the exact scenario
        // the rounds exist for
        let rescueSearches = 0;
        const localAdapters: Record<string, unknown> = {
            decoy: {
                searchMangas: async () => [{ id: 'd1', title: 'Starved Series' }],
                getChapters: async () => [{ id: 'c1', title: 'Ch.1', language: 'pl' }]
            },
            rescue: {
                searchMangas: async () => {
                    rescueSearches++;
                    return [{ id: 'r1', title: 'Starved Series' }];
                },
                getChapters: async () => Array.from({ length: 9 }, (_, index) => ({ id: `r${index}`, title: `Ch.${index + 1}`, language: 'en' }))
            }
        };
        const listSources = async () => [
            { id: 'decoy', label: 'Decoy', tags: ['English'], kind: 'native' },
            ...Array.from({ length: 24 }, (_, index) => ({ id: `filler${index}`, label: `Filler ${index}`, tags: ['English'], kind: 'native' })),
            { id: 'rescue', label: 'Rescue', tags: ['English'], kind: 'legacy' }
        ];
        const localFailover = new FailoverService({
            registry: { get: async (id: string) => localAdapters[id] ?? { searchMangas: async () => [] } } as never,
            store,
            listSources,
            getPreferredLanguages: () => ['en']
        });
        const alternatives = await localFailover.listAlternatives({ id: entryId, sourceId: 'current', title: 'Starved Series' });
        expect(alternatives.map(a => a.sourceId)).toEqual(['rescue']);
        expect(alternatives[0].chapterCount).toBe(9);
        expect(rescueSearches).toBe(1); // searched in round 2 only, never re-crawled
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

describe('search aliases (manual / AniList names)', () => {
    it('searches every alias until a source answers and scores against the best matching name', async () => {
        const queries: string[] = [];
        const adapters = {
            current: adapterWith(5, 'Aliased Series'),
            renamed: {
                // answers only when searched by the alias (the current title misses)
                searchMangas: async (query: string) => {
                    queries.push(query);
                    return query === 'Other Name' ? [{ id: 'x1', title: 'Other Name' }] : [];
                },
                getChapters: async () => Array.from({ length: 30 }, (_, index) => ({ id: `x${index + 1}`, title: `Ch.${index + 1}`, language: 'en' }))
            }
        };
        const aliasFailover = new FailoverService({
            registry: { get: async (id: string) => adapters[id], list: async () => [] } as never,
            store,
            listSources: async () => [
                { id: 'current', label: 'Current', tags: ['English'], kind: 'native' },
                { id: 'renamed', label: 'Renamed', tags: ['English'], kind: 'native' }
            ],
            getPreferredLanguages: () => ['en']
        });
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'am', title: 'Aliased Series', backlog: 'ignore' });
        store.setAliases(entry.id, ['Other Name']);
        const alternatives = await aliasFailover.listAlternatives({ id: entry.id, sourceId: 'current', title: 'Aliased Series' });
        // both names were tried per source; the alias is what found it
        expect(queries).toEqual(['Aliased Series', 'Other Name']);
        expect(alternatives.map(a => a.sourceId)).toEqual(['renamed']);
        // listed under the alias exactly: a perfect best-name match even
        // though the current title shares nothing with it
        expect(alternatives[0].score).toBe(1);
    });
});

describe('opt-in auto-migration on exact matches (autoMigrateExactMatch)', () => {
    let autoExactEnabled = false;
    let autoFailover: FailoverService;
    let autoId = 0;

    beforeAll(async () => {
        autoFailover = new FailoverService({
            registry: registry as never,
            store,
            listSources: async () => sourceInfos,
            getPreferredLanguages: () => ['en'],
            isDetectionEnabled: () => true,
            isAutoMigrateExactEnabled: () => autoExactEnabled
        });
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'ax', title: 'Starved Series', backlog: 'ignore' });
        autoId = entry.id;
    });

    it('stores a suggestion, never migrates, while the setting is off — even on an exact match', async () => {
        expect(await autoFailover.suggestIfIncomplete({ id: autoId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('suggested');
        const entry = store.getEntry(autoId);
        expect(entry?.migrationSuggestion?.sourceId).toBe('richer'); // score 1
        expect(entry?.sourceId).toBe('current');
    });

    it('migrates immediately on an exact match once enabled', async () => {
        store.setMigrationSuggestion(autoId, null);
        autoExactEnabled = true;
        expect(await autoFailover.suggestIfIncomplete({ id: autoId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe('suggested');
        const entry = store.getEntry(autoId);
        expect(entry?.sourceId).toBe('richer');
        expect(entry?.migrationSuggestion).toBeUndefined();
        expect(entry?.canRollbackMigration).toBe(true); // undo stays available
    });

    it('still only suggests when the best match is not exact (score < 100 %)', async () => {
        // the entry now lives on 'richer'; the only alternative with ≥ 2×
        // chapters is 'stranger' ("Starved Series — Official", score < 1)
        expect(await autoFailover.suggestIfIncomplete({ id: autoId, sourceId: 'richer', title: 'Starved Series' }, 8)).toBe('suggested');
        const entry = store.getEntry(autoId);
        expect(entry?.sourceId).toBe('richer');
        expect(entry?.migrationSuggestion?.sourceId).toBe('stranger');
    });
});

describe('minimum match score (weak lookalikes)', () => {
    it('never migrates, suggests, nor even probes a candidate below the review threshold', async () => {
        let probed = 0;
        const weakAdapters = {
            current: adapterWith(8, 'Into the Light, Once Again'),
            lookalike: {
                // 0.38 against the entry title — the KunManga case
                searchMangas: async () => [{ id: 'w1', title: 'Bait For Returning to The Cage' }],
                getChapters: async () => {
                    probed++;
                    return Array.from({ length: 100 }, (_, index) => ({ id: `w${index + 1}`, title: `Ch.${index + 1}`, language: 'en' }));
                }
            }
        };
        const weakFailover = new FailoverService({
            registry: { get: async (id: string) => weakAdapters[id] } as never,
            store,
            listSources: async () => [
                { id: 'current', label: 'Current', tags: ['English'], kind: 'native' },
                { id: 'lookalike', label: 'Lookalike', tags: ['English'], kind: 'native' }
            ],
            getPreferredLanguages: () => ['en'],
            isDetectionEnabled: () => true
        });
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'wm', title: 'Into the Light, Once Again', backlog: 'ignore' });
        // outage flow: the weak title is skipped before any chapter/page probe
        expect(await weakFailover.maybeMigrate({ id: entry.id, sourceId: 'current', title: entry.title })).toBe('none');
        expect(probed).toBe(0);
        // detection flow: the chapter count never makes up for the weak title
        expect(await weakFailover.suggestIfIncomplete({ id: entry.id, sourceId: 'current', title: entry.title }, 8)).toBe('miss');
        expect(store.getEntry(entry.id)?.migrationSuggestion).toBeUndefined();
    });
});

describe('outage failover (maybeMigrate)', () => {
    it('stores the probed chapter count on the suggestion — never “0 chapters”', async () => {
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'om', title: 'Starved Series', backlog: 'ignore' });
        expect(await failover.maybeMigrate({ id: entry.id, sourceId: 'current', title: entry.title }, false)).toBe('suggested');
        const suggestion = store.getEntry(entry.id)?.migrationSuggestion;
        expect(suggestion?.sourceId).toBe('poorer'); // score tie with 'richer': label order wins
        expect(suggestion?.chapterCount).toBe(3); // counted during the usability probe
    });
});

describe('linked provenances (library_alternatives)', () => {
    it('are offered first by the picker, without crawling', async () => {
        await store.addAlternative(entryId, { sourceId: 'stranger', mangaId: 'linked-1', title: 'Starved Series — Official' });
        const alternatives = await failover.listAlternatives({ id: entryId, sourceId: 'current', title: 'Starved Series' });
        // the linked provenance leads, ahead of any crawl hit
        expect(alternatives[0]).toMatchObject({ sourceId: 'stranger', mangaId: 'linked-1' });
        // consumed by a migration to it
        await store.migrateEntry(entryId, { sourceId: 'stranger', mangaId: 'linked-1', mangaTitle: 'Starved Series — Official' });
        expect(store.listAlternatives(entryId)).toHaveLength(0);
    });

    it('are the failover’s first migration target when the source dies', async () => {
        const { entry } = await store.addEntry({ sourceId: 'current', mangaId: 'lm', title: 'Linked Rescue', backlog: 'ignore' });
        await store.addAlternative(entry.id, { sourceId: 'richer', mangaId: 'lm-2', title: 'Linked Rescue' });
        expect(await failover.maybeMigrate({ id: entry.id, sourceId: 'current', title: 'Linked Rescue' })).toBe('migrated');
        const migrated = store.getEntry(entry.id);
        expect(migrated?.sourceId).toBe('richer');
        expect(migrated?.mangaId).toBe('lm-2');
    });
});
