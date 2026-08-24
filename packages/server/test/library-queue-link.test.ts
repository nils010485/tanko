import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { LibraryStore } from '../src/library/store.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let bus: EventBus;
let queue: DownloadQueue;

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
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });

    const row = database.db
        .prepare("INSERT INTO library (source_id, source_label, manga_id, title, auto_download, added_at) VALUES ('s', 'Source', 'm-1', 'Linked Series', 1, ?)")
        .run(new Date().toISOString());
    entryId = Number(row.lastInsertRowid);

    // a real (paused) queue backs the requeue test: enqueue writes actual
    // download_jobs rows we can assert on
    bus = new EventBus();
    queue = new DownloadQueue({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        events: bus,
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
    queue.pause(); // keep requeued jobs 'queued' so assertions are deterministic
});

afterAll(() => {
    queue.stop();
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

describe('download retry flow', () => {
    it('enqueueNewChapters includes failed chapters, not downloaded ones', () => {
        addChapter('r-new', 'new');
        addChapter('r-failed', 'failed');
        addChapter('r-done', 'downloaded');
        const stubQueue = { enqueue: vi.fn((items: unknown[]) => ({ added: items.length, skipped: 0, retried: 0 })) };

        const queued = store.enqueueNewChapters(entryId, stubQueue as never);

        expect(queued).toBe(2);
        expect(stubQueue.enqueue).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ chapterId: 'r-new' }), expect.objectContaining({ chapterId: 'r-failed' })])
        );
        expect(statusOf('r-new')).toBe('queued');
        expect(statusOf('r-failed')).toBe('queued');
        expect(statusOf('r-done')).toBe('downloaded');
    });

    it('requeueFailedAfterMigration re-queues the failed chapters on the new source', () => {
        const now = new Date().toISOString();
        const insertJob = database.db.prepare(
            `INSERT INTO download_jobs
            (entry_id, source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, created_at, updated_at)
         VALUES (?, 'old-source', 'old-manga', ?, 'Linked Series', ?, 'failed', 100, 1, 0, ?, ?)`
        );
        insertJob.run(entryId, 'old-c5', 'Chapter 5', now, now);
        insertJob.run(entryId, 'old-c6', 'Chapter 6', now, now);
        const insertChapter = database.db.prepare(
            'INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)'
        );
        insertChapter.run(entryId, 'new-c5', 'Chapter 5', 'new', now);
        insertChapter.run(entryId, 'new-c6', 'Chapter 6', 'new', now);
        insertChapter.run(entryId, 'new-c7', 'Chapter 7', 'new', now);
        insertChapter.run(entryId, 'new-extra', 'Extra', 'new', now);
        // already carried over by the migration: must NOT be re-queued
        insertChapter.run(entryId, 'new-dl', 'Chapter 5', 'downloaded', now);

        const queued = store.requeueFailedAfterMigration(entryId, queue);

        expect(queued).toBe(2);
        expect(statusOf('new-c5')).toBe('queued');
        expect(statusOf('new-c6')).toBe('queued');
        expect(statusOf('new-c7')).toBe('new');
        expect(statusOf('new-extra')).toBe('new');
        expect(statusOf('new-dl')).toBe('downloaded');
        const jobs = database.db.prepare("SELECT chapter_id FROM download_jobs WHERE entry_id = ? AND status = 'queued'").all(entryId) as any[];
        expect(jobs.map(job => job.chapter_id).sort()).toEqual(['new-c5', 'new-c6']);
        // the consumed old-source failures are purged: no resurrection via "retry failed"
        const failedLeft = database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE entry_id = ? AND status = 'failed'").get(entryId) as any;
        expect(failedLeft.n).toBe(0);
    });
});
