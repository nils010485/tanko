import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import type { StoreContext } from '../src/library/context.js';
import { makeQueries } from '../src/library/context.js';
import { allocateDirectory, backfillDirectories } from '../src/library/directories.js';
import { migrateLibrarySchema } from '../src/library/schema.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let ctx: StoreContext;
let insertCount = 0;

/** Row id of a freshly inserted legacy entry (directory NULL). */
function insertEntry(title: string, sourceLabel = 'Source'): number {
    insertCount++;
    const row = database.db
        .prepare(
            `INSERT INTO library (source_id, source_label, manga_id, title, auto_download, last_chapter_at, added_at)
             VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING id`
        )
        .get('src', sourceLabel, `m-${insertCount}`, title, new Date().toISOString(), new Date().toISOString()) as { id: number };
    return row.id;
}

function insertChapterPath(entryId: number, filePath: string): void {
    database.db
        .prepare(`INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at) VALUES (?, ?, ?, 'downloaded', ?, ?)`)
        .run(entryId, `c-${filePath}`, 'Chapter 1', filePath, new Date().toISOString());
}

function directoryOf(entryId: number): string | null {
    return (database.db.prepare('SELECT directory FROM library WHERE id = ?').get(entryId) as { directory: string | null }).directory;
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-dirs-'));
    database = new Database(tmpDir);
    migrateLibrarySchema(database);
});

beforeEach(() => {
    database.db.exec('DELETE FROM library_chapters; DELETE FROM chapter_history; DELETE FROM entry_snapshots; DELETE FROM library');
    ctx = {
        db: database,
        q: makeQueries(database),
        registry: {} as StoreContext['registry'],
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'series',
            chapterFormat: 'cbz',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        } as StoreContext['queueSettings']
    };
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('allocateDirectory', () => {
    it('returns the sanitized series name when free', () => {
        expect(allocateDirectory(ctx, { title: 'Series One', sourceLabel: 'Source', layout: 'series' })).toBe('Series One');
    });

    it('nests under the source when the layout says so', () => {
        expect(allocateDirectory(ctx, { title: 'Series One', sourceLabel: 'MangaDex', layout: 'source' })).toBe('MangaDex/Series One');
    });

    it('suffixes a name owned by another entry', () => {
        insertEntry('Alice');
        backfillDirectories(ctx); // first Alice owns 'Alice'
        expect(allocateDirectory(ctx, { title: 'Alice', sourceLabel: 'Source', layout: 'series' })).toBe('Alice (2)');
        insertEntry('Alice');
        backfillDirectories(ctx); // second Alice owns 'Alice (2)'
        expect(allocateDirectory(ctx, { title: 'Alice', sourceLabel: 'Source', layout: 'series' })).toBe('Alice (3)');
    });

    it('adopts an on-disk folder spelled with the other apostrophe', () => {
        fs.mkdirSync(path.join(ctx.queueSettings.dataDirectory, 'Can’t Stop Me'), { recursive: true });
        expect(allocateDirectory(ctx, { title: "Can't Stop Me", sourceLabel: 'Source', layout: 'series' })).toBe('Can’t Stop Me');
    });

    it('does not adopt an on-disk folder owned by another entry', () => {
        fs.mkdirSync(path.join(ctx.queueSettings.dataDirectory, 'Can’t Stop Me'), { recursive: true });
        const owner = insertEntry('Can’t Stop Me');
        backfillDirectories(ctx); // owner adopts its on-disk folder
        expect(directoryOf(owner)).toBe('Can’t Stop Me');
        expect(allocateDirectory(ctx, { title: "Can't Stop Me", sourceLabel: 'Source', layout: 'series' })).toBe("Can't Stop Me (2)");
    });
});

describe('backfillDirectories', () => {
    it('derives the directory from downloaded chapter paths (multi-segment)', () => {
        const id = insertEntry('Series One', 'Source');
        insertChapterPath(id, path.join(tmpDir, 'downloads', 'Source', 'Series One', 'Chapter 1.cbz'));
        expect(backfillDirectories(ctx)).toBe(1);
        expect(directoryOf(id)).toBe('Source/Series One');
    });

    it('falls back to the configured layout when nothing was downloaded', () => {
        const id = insertEntry('Series One');
        expect(backfillDirectories(ctx)).toBe(1);
        expect(directoryOf(id)).toBe('Series One');
    });

    it('allocates fresh when the files live outside the data directory', () => {
        const id = insertEntry('Series One');
        insertChapterPath(id, path.join(tmpDir, 'elsewhere', 'Series One', 'Chapter 1.cbz'));
        expect(backfillDirectories(ctx)).toBe(1);
        expect(directoryOf(id)).toBe('Series One');
    });

    it('keeps a shared folder both entries have files in, splits the empty one', () => {
        const a = insertEntry('Alice');
        const b = insertEntry('Alice');
        const shared = path.join(tmpDir, 'downloads', 'Alice');
        insertChapterPath(a, path.join(shared, 'Chapter 1.cbz'));
        insertChapterPath(b, path.join(shared, 'Chapter 2.cbz'));
        expect(backfillDirectories(ctx)).toBe(2);
        expect(directoryOf(a)).toBe('Alice');
        expect(directoryOf(b)).toBe('Alice'); // both have files: recorded share wins

        const c = insertEntry('Alice'); // no files, folder taken
        expect(backfillDirectories(ctx)).toBe(1);
        expect(directoryOf(c)).toBe('Alice (2)');
    });

    it('is idempotent', () => {
        insertEntry('Series One');
        expect(backfillDirectories(ctx)).toBe(1);
        expect(backfillDirectories(ctx)).toBe(0);
    });
});

describe('adoptDirectory (import adoption)', () => {
    it('points the entry at a scanned folder inside the data directory', async () => {
        const store = new LibraryStore({
            db: database,
            registry: {
                get: async () => ({ label: 'Source', getChapters: async () => [] }),
                list: async () => []
            } as never,
            queueSettings: ctx.queueSettings
        });
        const { entry } = await store.addEntry({ sourceId: 'src', mangaId: 'imp-1', title: 'Imported Series', backlog: 'ignore' });

        const folder = path.join(tmpDir, 'downloads', 'Série importée (2)');
        expect(store.adoptDirectory(entry.id, folder)).toBe('Série importée (2)');
        expect(directoryOf(entry.id)).toBe('Série importée (2)');

        // outside the data directory: refused, the allocated directory stands
        expect(store.adoptDirectory(entry.id, path.join(tmpDir, 'elsewhere', 'X'))).toBeNull();
        expect(directoryOf(entry.id)).toBe('Série importée (2)');
    });
});
