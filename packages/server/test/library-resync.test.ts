import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

const fakeSource = {
    label: 'Source',
    getChapters: async () => [
        { id: 'c1', title: 'Chapter 1', language: 'en' },
        { id: 'c2', title: 'Chapter 2', language: 'en' }
    ]
};

const fakeRegistry = {
    get: async () => fakeSource,
    list: async () => []
};

function chapterStatus(entryId: number, chapterId: string): string | undefined {
    return (
        database.db.prepare('SELECT status FROM library_chapters WHERE entry_id = ? AND chapter_id = ?').get(entryId, chapterId) as
            | { status: string }
            | undefined
    )?.status;
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-resync-'));
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

describe('resyncLocalFiles', () => {
    it('marks known chapters downloaded from files on disk (both naming styles)', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src', mangaId: 'm1', title: 'Series One', backlog: 'ignore' });
        expect(chapterStatus(entry.id, 'c1')).toBe('missing');
        const dir = path.join(tmpDir, 'downloads', 'Source', 'Series One');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Chapter 1.cbz'), 'x');
        fs.writeFileSync(path.join(dir, 'Series One - Ch.2.cbz'), 'x');

        const result = await store.resyncLocalFiles();
        expect(result).toMatchObject({ attached: 2, entries: 1 });
        expect(chapterStatus(entry.id, 'c1')).toBe('downloaded');
        expect(chapterStatus(entry.id, 'c2')).toBe('downloaded');
    });

    it('re-creates missing rows from the source before attaching (import whose sync failed)', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src', mangaId: 'm2', title: 'Series Two', backlog: 'ignore' });
        // simulate a failed import sync: rows wiped, files already on disk
        database.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entry.id);
        const dir = path.join(tmpDir, 'downloads', 'Source', 'Series Two');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Chapter 1.cbz'), 'x');

        const result = await store.resyncLocalFiles();
        expect(result.checked).toBeGreaterThanOrEqual(1);
        expect(chapterStatus(entry.id, 'c1')).toBe('downloaded');
        expect(chapterStatus(entry.id, 'c2')).toBe('new'); // genuinely missing from disk
    });

    it('registers files the source never listed as local-only chapters', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src', mangaId: 'm4', title: 'Series Four', backlog: 'ignore' });
        const dir = path.join(tmpDir, 'downloads', 'Source', 'Series Four');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'Chapter 9.cbz'), 'x');

        const result = await store.resyncLocalFiles();
        expect(result.attached).toBeGreaterThanOrEqual(1);
        expect(chapterStatus(entry.id, 'local:9')).toBe('downloaded');
        expect(store.listChapters(entry.id).find(chapter => chapter.chapterId === 'local:9')?.localOnly).toBe(true);
    });
    it('leaves entries without files untouched', async () => {
        await store.addEntry({ sourceId: 'src', mangaId: 'm3', title: 'Series Three', backlog: 'ignore' });
        const result = await store.resyncLocalFiles();
        expect(result.entries).toBe(3); // the three series with files above
    });
});
