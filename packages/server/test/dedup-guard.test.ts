import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

// one chapter list shape reused by both fake sources
const chapters = [
    { id: 'c1', title: 'Chapter 1', language: 'en' },
    { id: 'c2', title: 'Chapter 2', language: 'en' }
];

const fakeRegistry = {
    get: async () => ({ label: 'Source', getChapters: async () => chapters }),
    list: async () => []
};

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-dedup-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
        db: database,
        registry: fakeRegistry as never,
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'cbz',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findEntryByTitle (cross-source duplicate guard)', () => {
    it('matches across sources, ignoring case and punctuation', async () => {
        const { entry } = await store.addEntry({ sourceId: 'kali', mangaId: 'm-1', title: 'Pick Me Up, Infinite Gacha' });
        expect(entry.id).toBeGreaterThan(0);

        // the same series as titled by another source
        expect(store.findEntryByTitle('Pick Me Up: Infinite Gacha')?.id).toBe(entry.id);
        expect(store.findEntryByTitle('pick me up infinite gacha')?.id).toBe(entry.id);
        // a genuinely different series
        expect(store.findEntryByTitle('Solo Max-Level Newbie')).toBeNull();
    });

    it('matches hidden entries too (they still occupy the title)', () => {
        expect(store.findEntryByTitle('Pick Me Up, Infinite Gacha')).not.toBeNull();
    });
});

describe('markDownloadedByNumber (re-import reconciliation)', () => {
    it('marks not-yet-downloaded chapters with their local file, skips already-downloaded ones', async () => {
        const { entry } = await store.addEntry({ sourceId: 'mangadex', mangaId: 'm-2', title: 'Solo Max-Level Newbie' });
        const rows = store.listChapters(entry.id);
        expect(rows.every(chapter => chapter.status === 'new')).toBe(true);

        const matched = store.markDownloadedByNumber(
            entry.id,
            new Map([
                [1, '/data/solo/chapter-001.cbz'],
                [2, '/data/solo/chapter-002.cbz'],
                [99, '/data/solo/chapter-099.cbz'] // no such chapter on the source
            ])
        );
        expect(matched).toBe(2);

        const after = store.listChapters(entry.id);
        const byChapterId = new Map(after.map(chapter => [chapter.chapterId, chapter]));
        expect(byChapterId.get('c1')?.status).toBe('downloaded');
        expect(byChapterId.get('c1')?.path).toBe('/data/solo/chapter-001.cbz');
        expect(byChapterId.get('c2')?.status).toBe('downloaded');

        // a second pass must not churn already-downloaded chapters
        const again = store.markDownloadedByNumber(entry.id, new Map([[1, '/data/solo/chapter-001.cbz']]));
        expect(again).toBe(1);
        expect(store.listChapters(entry.id).find(chapter => chapter.chapterId === 'c1')?.path).toBe('/data/solo/chapter-001.cbz');
    });
});
