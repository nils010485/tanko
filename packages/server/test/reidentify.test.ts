/**
 * Re-identification guard: when a source rotates the ids of its whole
 * catalogue (Asura Scans rotates a shared build code embedded in every
 * URL), the listing looks entirely unknown while the chapter numbers
 * still match the stored rows — the existing rows must be re-identified
 * in place instead of the whole series being treated as brand new.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;

/** Chapter listing served by the fake source (mutated per test). */
let listing: Array<{ id: string; title: string; language?: string }> = [];

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-reidentify-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
        db: database,
        registry: {
            get: async (id: string) => ({ label: id, getChapters: async () => listing }),
            list: async () => []
        } as never,
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
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

const rows = (entryId: number) =>
    database.db.prepare('SELECT chapter_id, title, status, path FROM library_chapters WHERE entry_id = ? ORDER BY id').all(entryId);

describe('checkForNewChapters — re-identification guard', () => {
    it('re-ids stored rows on an overwhelming id rotation instead of re-adding everything', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-reid1', mangaId: 'm', title: 'Rotated Ids', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, 'en', 'downloaded', ?, ?, ?)"
        );
        for (let n = 1; n <= 8; n++) {
            insert.run(
                entry.id,
                `https://example.com/old-code/chapter/${n}`,
                `Chapter ${n}`,
                `/biblio/Series/Chapter ${n}.cbz`,
                new Date().toISOString(),
                new Date().toISOString()
            );
        }

        listing = Array.from({ length: 8 }, (_, i) => ({ id: `https://example.com/new-code/chapter/${i + 1}`, title: `Chapter ${i + 1}` }));
        const { fresh, usableSeen } = await store.checkForNewChapters(entry.id);

        expect(usableSeen).toBe(8);
        expect(fresh).toHaveLength(0);
        const after = rows(entry.id);
        expect(after).toHaveLength(8);
        for (const row of after) {
            expect(row.chapter_id).toContain('/new-code/');
            expect(row.status).toBe('downloaded');
            expect(row.path).toContain('/biblio/');
        }
    });

    it('still reports genuinely new chapters alongside a rotation', async () => {
        listing = [];
        const { entry } = await store.addEntry({ sourceId: 'src-reid2', mangaId: 'm', title: 'Rotation Plus New', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, 'en', 'downloaded', ?)"
        );
        for (let n = 1; n <= 10; n++) {
            insert.run(entry.id, `https://example.com/old-code/chapter/${n}`, `Chapter ${n}`, new Date().toISOString());
        }

        listing = Array.from({ length: 11 }, (_, i) => ({ id: `https://example.com/new-code/chapter/${i + 1}`, title: `Chapter ${i + 1}` }));
        const { fresh } = await store.checkForNewChapters(entry.id);

        expect(fresh.map(chapter => chapter.title)).toEqual(['Chapter 11']);
        expect(rows(entry.id)).toHaveLength(11);
    });

    it('does not absorb small mismatches (renumbering safety)', async () => {
        listing = [];
        const { entry } = await store.addEntry({ sourceId: 'src-reid3', mangaId: 'm', title: 'Small Mismatch', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, 'en', 'new', ?)"
        );
        for (let n = 1; n <= 5; n++) {
            insert.run(entry.id, `https://example.com/old-code/chapter/${n}`, `Chapter ${n}`, new Date().toISOString());
        }

        listing = Array.from({ length: 5 }, (_, i) => ({ id: `https://example.com/new-code/chapter/${i + 1}`, title: `Chapter ${i + 1}` }));
        const { fresh } = await store.checkForNewChapters(entry.id);

        expect(fresh).toHaveLength(5);
    });
});

describe('schema migration — asura id normalization', () => {
    it('strips the build code and merges rotation duplicates once', async () => {
        listing = [];
        const { entry } = await store.addEntry({ sourceId: 'asurascans', mangaId: '/comics/murim-login-08677664', title: 'Murim Login', backlog: 'ignore' });
        database.db
            .prepare(
                "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, path, discovered_at, downloaded_at) VALUES (?, ?, 'Chapter 1', 'en', 'downloaded', '/biblio/Murim Login/Chapter 1.cbz', ?, ?)"
            )
            .run(entry.id, 'https://asurascans.com/comics/murim-login-08677664/chapter/1', new Date().toISOString(), new Date().toISOString());
        database.db
            .prepare("INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, 'Chapter 1', 'en', 'new', ?)")
            .run(entry.id, 'https://asurascans.com/comics/murim-login-53fc8424/chapter/1', new Date().toISOString());

        database.db.prepare("DELETE FROM settings WHERE key = 'schema.asuraIdsNormalized'").run();
        new LibraryStore({
            db: database,
            registry: { get: async () => undefined, list: async () => [] } as never,
            queueSettings: {
                dataDirectory: path.join(tmpDir, 'downloads'),
                directoryLayout: 'source',
                chapterFormat: 'img',
                parallelSources: 1,
                concurrencyPerSource: 1,
                throttleMs: 0
            }
        });

        const migrated = rows(entry.id);
        expect(migrated).toHaveLength(1);
        expect(migrated[0]).toMatchObject({
            chapter_id: 'https://asurascans.com/comics/murim-login/chapter/1',
            status: 'downloaded',
            path: '/biblio/Murim Login/Chapter 1.cbz'
        });
        const manga = database.db.prepare('SELECT manga_id FROM library WHERE id = ?').get(entry.id) as { manga_id: string };
        expect(manga.manga_id).toBe('/comics/murim-login');
    });
});
