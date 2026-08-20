import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

let entryId: number;

function addChapter(chapterId: string, status: string): void {
    database.db
        .prepare('INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)')
        .run(entryId, chapterId, chapterId, status, new Date().toISOString());
}

function statusOf(chapterId: string): string {
    const row = database.db.prepare('SELECT status FROM library_chapters WHERE entry_id = ? AND chapter_id = ?').get(entryId, chapterId) as {
        status: string;
    };
    return row.status;
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-link-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'cbz',
            concurrency: 1,
            throttleMs: 0
        }
    });

    const row = database.db
        .prepare("INSERT INTO library (source_id, source_label, manga_id, title, auto_download, added_at) VALUES ('s', 'Source', 'm-1', 'Linked Series', 1, ?)")
        .run(new Date().toISOString());
    entryId = Number(row.lastInsertRowid);
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ad-hoc download linkage', () => {
    it('findEntryByManga resolves tracked series and ignores the rest', () => {
        expect(store.findEntryByManga('s', 'm-1')?.id).toBe(entryId);
        expect(store.findEntryByManga('s', 'unknown')).toBeNull();
        expect(store.findEntryByManga('other', 'm-1')).toBeNull();
    });

    it('markChaptersQueued flips new/missing/failed chapters but not downloaded ones', () => {
        addChapter('c-new', 'new');
        addChapter('c-missing', 'missing');
        addChapter('c-failed', 'failed');
        addChapter('c-done', 'downloaded');

        const flipped = store.markChaptersQueued(entryId, ['c-new', 'c-missing', 'c-failed', 'c-done', 'c-unknown']);

        expect(flipped).toBe(3);
        expect(statusOf('c-new')).toBe('queued');
        expect(statusOf('c-missing')).toBe('queued');
        expect(statusOf('c-failed')).toBe('queued');
        expect(statusOf('c-done')).toBe('downloaded');
    });

    it('markChaptersQueued is a no-op for an empty list', () => {
        expect(store.markChaptersQueued(entryId, [])).toBe(0);
    });
});
