import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import type { SourceInfo } from '../src/import/service.js';
import { FailoverService } from '../src/library/failover.js';
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

describe('manual source picker (listAlternatives)', () => {
    it('lists one candidate per source, sorted by chapter count', async () => {
        const alternatives = await failover.listAlternatives({ id: entryId, sourceId: 'current', title: 'Starved Series' });
        // the current source is excluded; one row per remaining source
        expect(alternatives.map(a => a.sourceId)).toEqual(['richer', 'stranger', 'poorer']);
        expect(alternatives[0].chapterCount).toBe(120);
        expect(alternatives[0].score ?? 0).toBeGreaterThan(0.9);
    });
});

describe('opt-in starved-source detection (suggestIfIncomplete)', () => {
    it('does nothing while the setting is off', async () => {
        detectionEnabled = false;
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe(false);
        expect(store.getEntry(entryId)?.migrationSuggestion).toBeUndefined();
    });

    it('suggests a source with at least twice the chapters when enabled', async () => {
        detectionEnabled = true;
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe(true);
        const suggestion = store.getEntry(entryId)?.migrationSuggestion;
        expect(suggestion?.sourceId).toBe('richer');
        expect(suggestion?.chapterCount ?? 0).toBeGreaterThanOrEqual(16);
    });

    it('skips entries that already have a pending suggestion', async () => {
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 8)).toBe(false);
    });

    it('skips entries with more chapters than the threshold', async () => {
        store.setMigrationSuggestion(entryId, null);
        expect(await failover.suggestIfIncomplete({ id: entryId, sourceId: 'current', title: 'Starved Series' }, 42)).toBe(false);
        expect(store.getEntry(entryId)?.migrationSuggestion).toBeUndefined();
    });
});
