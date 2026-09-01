import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

// removeEntry: journal purge + folder removal computed before the cascade.
let tmpDir: string;
let database: Database;
let store: LibraryStore;
let casedFolder: string;
let keptFolder: string;

let entryCased: number;
let entryKept: number;

const storeOptions = () => ({
    db: database,
    registry: { get: async () => undefined, list: async () => [] } as never,
    queueSettings: {
        dataDirectory: path.join(tmpDir, 'downloads'),
        directoryLayout: 'source',
        chapterFormat: 'cbz',
        parallelSources: 1,
        concurrencyPerSource: 1,
        throttleMs: 0
    }
});

function addEntry(title: string): number {
    const row = database.db
        .prepare("INSERT INTO library (source_id, source_label, manga_id, title, auto_download, added_at) VALUES ('s', 'Source', ?, ?, 1, ?)")
        .run(title.toLowerCase().replace(/\s+/g, '-'), title, new Date().toISOString());
    return Number(row.lastInsertRowid);
}

function addChapter(entryId: number, chapterPath: string | null): void {
    database.db
        .prepare('INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entryId, 'chapter-1', 'Chapter 1', 'downloaded', chapterPath, new Date().toISOString(), new Date().toISOString());
}

function addJournals(entryId: number): void {
    const now = new Date().toISOString();
    database.db
        .prepare("INSERT INTO chapter_history (entry_id, chapter_id, title, event, at) VALUES (?, 'chapter-1', 'Chapter 1', 'downloaded', ?)")
        .run(entryId, now);
    database.db.prepare("INSERT INTO entry_snapshots (entry_id, reason, data, at) VALUES (?, 'test', '{}', ?)").run(entryId, now);
}

function countRows(table: string, entryId: number): number {
    const column = table === 'library' ? 'id' : 'entry_id';
    return Number((database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(entryId) as { n: number }).n);
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-remove-'));
    database = new Database(tmpDir);
    store = new LibraryStore(storeOptions());

    // folder name the layout fallback cannot resolve from the title
    entryCased = addEntry('Cased Series');
    casedFolder = path.join(tmpDir, 'downloads', 'Source', 'Cased Series (import)');
    fs.mkdirSync(casedFolder, { recursive: true });
    fs.writeFileSync(path.join(casedFolder, 'Chapter 1.cbz'), 'cbz');
    addChapter(entryCased, path.join(casedFolder, 'Chapter 1.cbz'));
    addJournals(entryCased);

    entryKept = addEntry('Kept Series');
    keptFolder = path.join(tmpDir, 'downloads', 'Source', 'Kept Series');
    fs.mkdirSync(keptFolder, { recursive: true });
    fs.writeFileSync(path.join(keptFolder, 'Chapter 1.cbz'), 'cbz');
    addChapter(entryKept, path.join(keptFolder, 'Chapter 1.cbz'));
    addJournals(entryKept);
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LibraryStore removeEntry', () => {
    it('clears every table and deletes a folder the layout fallback cannot resolve, with disk: true', () => {
        const result = store.removeEntry(entryCased, { disk: true });
        expect(result).toEqual({ ok: true, deletedPath: casedFolder });
        for (const table of ['library', 'library_chapters', 'chapter_history', 'entry_snapshots']) {
            expect(countRows(table, entryCased)).toBe(0);
        }
        expect(fs.existsSync(casedFolder)).toBe(false);
    });

    it('purges the journals but keeps the folder without disk', () => {
        const result = store.removeEntry(entryKept);
        expect(result).toEqual({ ok: true });
        for (const table of ['library', 'library_chapters', 'chapter_history', 'entry_snapshots']) {
            expect(countRows(table, entryKept)).toBe(0);
        }
        expect(fs.existsSync(keptFolder)).toBe(true);
    });

    it('answers ok: false for an unknown entry', () => {
        expect(store.removeEntry(424242)).toEqual({ ok: false });
    });

    it('purges orphaned journal rows left by older removeEntry implementations', () => {
        const entryId = addEntry('Orphaned Series');
        addChapter(entryId, null);
        addJournals(entryId);
        // legacy delete: entry row only, FKs off lets the chapter escape the cascade
        database.db.exec('PRAGMA foreign_keys = OFF');
        database.db.prepare('DELETE FROM library WHERE id = ?').run(entryId);
        database.db.exec('PRAGMA foreign_keys = ON');

        new LibraryStore(storeOptions()); // re-runs the schema migration

        for (const table of ['library_chapters', 'chapter_history', 'entry_snapshots']) {
            expect(countRows(table, entryId)).toBe(0);
        }
    });
});
