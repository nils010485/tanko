import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

/** The user's exact scenario: the first import matched a starved source that
 *  listed a single chapter — one file got marked downloaded, the other local
 *  files were never registered. A rematch migrates the entry to a richer
 *  source: the rebuild must carry the disk files over, not just DB rows, and
 *  keep files with no source counterpart visible as local-only chapters. */
const richChapters = Array.from({ length: 50 }, (_, index) => ({ id: `r${index + 1}`, title: `Chapter ${index + 1}`, language: 'en' }));

const adapters: Record<string, { label: string; getChapters: () => Promise<Array<{ id: string; title: string; language: string }>> }> = {
    starved: {
        label: 'Starved',
        getChapters: async () => [{ id: 'only', title: 'Chapter 1', language: 'en' }]
    },
    rich: {
        label: 'Rich',
        getChapters: async () => richChapters
    }
};

const registry = {
    get: async (id: string) => adapters[id],
    list: async () => []
};

function chapterRow(entryId: number, chapterId: string): { status: string; path: string | null } | undefined {
    return database.db.prepare('SELECT status, path FROM library_chapters WHERE entry_id = ? AND chapter_id = ?').get(entryId, chapterId) as
        | { status: string; path: string | null }
        | undefined;
}

function rowCount(entryId: number): number {
    return Number((database.db.prepare('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?').get(entryId) as { n: number }).n);
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-migrate-'));
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
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migrateEntry', () => {
    it('carries local disk files over, not just chapters marked downloaded in the DB', async () => {
        const { entry } = await store.addEntry({ sourceId: 'starved', mangaId: 'm1', title: 'Series X', backlog: 'ignore' });

        // import-like folder outside the downloads directory: 30 known chapters
        // plus one file (ch. 60) the rich source does not list
        const importDir = path.join(tmpDir, 'mangas', 'Series X');
        fs.mkdirSync(importDir, { recursive: true });
        for (let index = 1; index <= 28; index++) {
            fs.writeFileSync(path.join(importDir, `Chapter ${index}.cbz`), 'x');
        }
        fs.writeFileSync(path.join(importDir, 'Series X - Ch.29.cbz'), 'x');
        fs.writeFileSync(path.join(importDir, 'Series X - Ch.30.cbz'), 'x');
        fs.writeFileSync(path.join(importDir, 'Chapter 60.cbz'), 'x');

        // the original import only marked the one chapter the starved source listed
        store.markChapter(entry.id, 'only', 'downloaded', path.join(importDir, 'Chapter 1.cbz'), 'import');
        expect(chapterRow(entry.id, 'only')?.status).toBe('downloaded');

        const result = await store.migrateEntry(entry.id, { sourceId: 'rich', mangaId: 'm2', mangaTitle: 'Series X' });

        expect(result.total).toBe(50);
        expect(result.kept).toBe(31);
        expect(chapterRow(entry.id, 'r1')?.status).toBe('downloaded');
        expect(chapterRow(entry.id, 'r1')?.path).toBe(path.join(importDir, 'Chapter 1.cbz'));
        expect(chapterRow(entry.id, 'r29')?.path).toBe(path.join(importDir, 'Series X - Ch.29.cbz'));
        expect(chapterRow(entry.id, 'r31')?.status).toBe('new');
        expect(chapterRow(entry.id, 'r31')?.path).toBeNull();
        // the file the source ignores stays visible as a local-only chapter
        expect(chapterRow(entry.id, 'local:60')?.status).toBe('downloaded');
        expect(chapterRow(entry.id, 'local:60')?.path).toBe(path.join(importDir, 'Chapter 60.cbz'));
        expect(rowCount(entry.id)).toBe(51);
        expect(store.listChapters(entry.id).find(chapter => chapter.chapterId === 'local:60')?.localOnly).toBe(true);
    });

    it('absorbs a local-only chapter when the source starts listing its number (no duplicate, file kept)', async () => {
        const entries = await store.listEntries();
        const entry = entries.find(item => item.title === 'Series X');
        expect(entry).toBeDefined();
        if (!entry) {
            return;
        }

        richChapters.push({ id: 'r60', title: 'Chapter 60', language: 'en' });
        const { fresh } = await store.checkForNewChapters(entry.id);

        expect(fresh).toHaveLength(0); // chapter 60 is not new: the file is already on disk
        expect(chapterRow(entry.id, 'local:60')).toBeUndefined();
        expect(chapterRow(entry.id, 'r60')?.status).toBe('downloaded');
        expect(chapterRow(entry.id, 'r60')?.path).toContain('Chapter 60.cbz');
        expect(rowCount(entry.id)).toBe(51); // absorbed in place, nothing duplicated
    });
});
