import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

let entryAlive: number;
let entryDead: number;
let entryNew: number;
let deadDirectory: string;

function addEntry(title: string, hidden = false): number {
    const row = database.db
        .prepare("INSERT INTO library (source_id, source_label, manga_id, title, auto_download, hidden, added_at) VALUES ('s', 'Source', ?, ?, 1, ?, ?)")
        .run(title.toLowerCase().replace(/\s+/g, '-'), title, hidden ? 1 : 0, new Date().toISOString());
    return Number(row.lastInsertRowid);
}

function addChapter(entryId: number, title: string, chapterPath: string | null, status = 'downloaded'): void {
    database.db
        .prepare('INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entryId, title, title, status, chapterPath, new Date().toISOString(), status === 'downloaded' ? new Date().toISOString() : null);
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-prune-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
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

    // alive: chapter file present on disk
    entryAlive = addEntry('Alive Series');
    const aliveDirectory = path.join(tmpDir, 'downloads', 'Source', 'Alive Series');
    fs.mkdirSync(aliveDirectory, { recursive: true });
    fs.writeFileSync(path.join(aliveDirectory, 'Chapter 1.cbz'), 'cbz');
    addChapter(entryAlive, 'Chapter 1', path.join(aliveDirectory, 'Chapter 1.cbz'));

    // dead (hidden, to also cover hidden entries): recorded paths point nowhere
    entryDead = addEntry('Dead Series', true);
    deadDirectory = path.join(tmpDir, 'downloads', 'Source', 'Dead Series');
    addChapter(entryDead, 'Chapter 1', path.join(deadDirectory, 'Chapter 1.cbz'));
    addChapter(entryDead, 'Chapter 2', path.join(deadDirectory, 'Chapter 2.cbz'));

    // never downloaded: no path on record, nothing expected on disk
    entryNew = addEntry('Followed Only');
    addChapter(entryNew, 'Chapter 1', null, 'new');
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LibraryStore prune', () => {
    it('findDeadEntries reports only entries whose files vanished', () => {
        const dead = store.findDeadEntries();
        expect(dead).toHaveLength(1);
        expect(dead[0]).toMatchObject({ id: entryDead, title: 'Dead Series', directory: deadDirectory });
    });

    it('pruneEntries removes the dead entry and its chapters, keeps the rest', () => {
        const now = new Date().toISOString();
        database.db
            .prepare("INSERT INTO chapter_history (entry_id, chapter_id, title, event, at) VALUES (?, 'chapter-1', 'Chapter 1', 'downloaded', ?)")
            .run(entryDead, now);
        database.db.prepare("INSERT INTO entry_snapshots (entry_id, reason, data, at) VALUES (?, 'test', '{}', ?)").run(entryDead, now);

        expect(store.pruneEntries([])).toBe(0);
        // server-side re-validation: alive entries are refused even on request
        expect(store.pruneEntries([entryAlive, entryNew])).toBe(0);
        expect(store.pruneEntries([entryDead])).toBe(1);

        expect(store.getEntry(entryDead)).toBeUndefined();
        expect(store.getEntry(entryAlive)).toBeDefined();
        expect(store.getEntry(entryNew)).toBeDefined();

        const chapters = database.db.prepare('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?').get(entryDead) as { n: number };
        expect(chapters.n).toBe(0);
        const history = database.db.prepare('SELECT COUNT(*) AS n FROM chapter_history WHERE entry_id = ?').get(entryDead) as { n: number };
        expect(history.n).toBe(0);
        const snapshots = database.db.prepare('SELECT COUNT(*) AS n FROM entry_snapshots WHERE entry_id = ?').get(entryDead) as { n: number };
        expect(snapshots.n).toBe(0);

        expect(store.findDeadEntries()).toHaveLength(0);
    });
});
