import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { LibraryStore } from '../src/library/store.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let queue: DownloadQueue;

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

function statusOf(entryId: number, chapterId: string): { status: string; prev_status: string | null } {
    return database.db.prepare('SELECT status, prev_status FROM library_chapters WHERE entry_id = ? AND chapter_id = ?').get(entryId, chapterId) as {
        status: string;
        prev_status: string | null;
    };
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-follow-'));
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
    queue = new DownloadQueue({
        db: database,
        registry: fakeRegistry as never,
        events: new EventBus(),
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            chapterFormat: 'cbz',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
    // paused: enqueued rows stay 'queued' so the assertions never race the worker
    queue.pause();
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('follow backlog semantics', () => {
    it('backlog "ignore" snapshots the catalog as missing, out of the new count and of download-new', async () => {
        const { entry } = await store.addEntry({ sourceId: 's', mangaId: 'monitor-only', title: 'Monitor Only', backlog: 'ignore' });
        expect(statusOf(entry.id, 'c1').status).toBe('missing');
        expect(statusOf(entry.id, 'c2').status).toBe('missing');
        expect(entry.newCount).toBe(0);

        const enqueued: unknown[] = [];
        const recordingQueue = {
            enqueue: (items: unknown[]) => {
                enqueued.push(...items);
                return { added: items.length, skipped: 0, retried: 0 };
            }
        };
        expect(store.enqueueNewChapters(entry.id, recordingQueue as never)).toBe(0);
        expect(enqueued).toHaveLength(0);
    });

    it('backlog "grab" keeps the catalog new and download-new queues it', async () => {
        const { entry } = await store.addEntry({ sourceId: 's', mangaId: 'grab-me', title: 'Grab Me', backlog: 'grab' });
        expect(entry.newCount).toBe(2);

        const queued = store.enqueueNewChapters(entry.id, { enqueue: () => ({ added: 2, skipped: 0, retried: 0 }) } as never);
        expect(queued).toBe(2);
        expect(statusOf(entry.id, 'c1')).toMatchObject({ status: 'queued', prev_status: 'new' });
    });
});

describe('queue entry linkage', () => {
    it('re-enqueue backfills entry_id on active duplicates and on retries', async () => {
        const chapter = { sourceId: 's', mangaId: 'late-follow', mangaTitle: 'Late Follow', chapterId: 'c1', chapterTitle: 'Chapter 1' };

        // queued before the manga was followed: no entry link
        queue.enqueue([chapter]);
        let row = database.db
            .prepare('SELECT entry_id, status FROM download_jobs WHERE source_id = ? AND manga_id = ? AND chapter_id = ?')
            .get(chapter.sourceId, chapter.mangaId, chapter.chapterId) as { entry_id: number | null; status: string };
        expect(row.status).toBe('queued');
        expect(row.entry_id).toBeNull();

        // followed then re-enqueued: the active duplicate gets its link backfilled
        const { entry } = await store.addEntry({ sourceId: 's', mangaId: 'late-follow', title: 'Late Follow', backlog: 'ignore' });
        const result = queue.enqueue([{ ...chapter, entryId: entry.id }]);
        expect(result.skipped).toBe(1);
        row = database.db
            .prepare(
                'SELECT entry_id, status FROM download_jobs WHERE id = (SELECT id FROM download_jobs WHERE source_id = ? AND manga_id = ? AND chapter_id = ?)'
            )
            .get(chapter.sourceId, chapter.mangaId, chapter.chapterId) as { entry_id: number | null; status: string };
        expect(row.entry_id).toBe(entry.id);

        // and so does a failed job being retried
        database.db
            .prepare('UPDATE download_jobs SET status = ? WHERE source_id = ? AND manga_id = ? AND chapter_id = ?')
            .run('failed', chapter.sourceId, chapter.mangaId, chapter.chapterId);
        const retried = queue.enqueue([{ ...chapter, entryId: entry.id }]);
        expect(retried.retried).toBe(1);
        row = database.db
            .prepare('SELECT entry_id, status FROM download_jobs WHERE source_id = ? AND manga_id = ? AND chapter_id = ?')
            .get(chapter.sourceId, chapter.mangaId, chapter.chapterId) as { entry_id: number | null; status: string };
        expect(row).toMatchObject({ entry_id: entry.id, status: 'queued' });
    });
});

describe('cancelled downloads revert to the pre-queue status', () => {
    it('a cancelled monitor-only chapter goes back to missing, not new', async () => {
        const { entry } = await store.addEntry({ sourceId: 's', mangaId: 'cancel-me', title: 'Cancel Me', backlog: 'ignore' });
        store.markChaptersQueued(entry.id, ['c1']);
        expect(statusOf(entry.id, 'c1')).toMatchObject({ status: 'queued', prev_status: 'missing' });

        store.revertCancelledChapter(entry.id, 'c1');
        expect(statusOf(entry.id, 'c1')).toMatchObject({ status: 'missing', prev_status: null });
    });

    it('a queued chapter without recorded history falls back to new', async () => {
        const { entry } = await store.addEntry({ sourceId: 's', mangaId: 'legacy', title: 'Legacy', backlog: 'grab' });
        // simulate a legacy row queued before prev_status existed
        database.db.prepare("UPDATE library_chapters SET status = 'queued', prev_status = NULL WHERE entry_id = ?").run(entry.id);
        store.revertCancelledChapter(entry.id, 'c2');
        expect(statusOf(entry.id, 'c2').status).toBe('new');
    });
});

describe('stale series tracking (last_chapter_at)', () => {
    it('sets the date at follow time, refreshes it on new chapters and drives listStaleEntries', async () => {
        const { entry } = await store.addEntry({ sourceId: 'Source', mangaId: 'm-stale', title: 'Stale' });
        expect(entry.lastChapterAt).toBeTruthy();

        // unknown date (legacy/import) backfills to today -> not stale
        expect(store.listStaleEntries(90).find(item => item.id === entry.id)).toBeUndefined();

        // an old last-chapter date -> stale
        database.db.prepare('UPDATE library SET last_chapter_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', entry.id);
        expect(store.listStaleEntries(90).find(item => item.id === entry.id)).toBeDefined();

        // a failing source must not be mistaken for an abandoned series
        database.db.prepare('UPDATE library SET check_failures = 2 WHERE id = ?').run(entry.id);
        expect(store.listStaleEntries(90).find(item => item.id === entry.id)).toBeUndefined();
        database.db.prepare('UPDATE library SET check_failures = 0 WHERE id = ?').run(entry.id);

        // unhide grants a fresh stale period (the series is not re-hidden
        // by the next scheduler run just because it is on a long hiatus)
        store.setHidden(entry.id, true);
        database.db.prepare('UPDATE library SET last_chapter_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', entry.id);
        store.setHidden(entry.id, false);
        expect(store.listStaleEntries(120).find(item => item.id === entry.id)).toBeUndefined();

        // a hidden entry is never reported, even with an old date
        store.setHidden(entry.id, true);
        database.db.prepare('UPDATE library SET last_chapter_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', entry.id);
        expect(store.listStaleEntries(120).find(item => item.id === entry.id)).toBeUndefined();
        store.setHidden(entry.id, false);

        // re-following an existing series rearms the stale period
        database.db.prepare('UPDATE library SET last_chapter_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', entry.id);
        await store.addEntry({ sourceId: 'Source', mangaId: 'm-stale', title: 'Stale' });
        expect(store.listStaleEntries(120).find(item => item.id === entry.id)).toBeUndefined();

        // a discovered chapter refreshes the date -> not stale anymore
        const original = fakeSource.getChapters;
        fakeSource.getChapters = async () => [
            { id: 'c1', title: 'Chapter 1', language: 'en' },
            { id: 'c2', title: 'Chapter 2', language: 'en' },
            { id: 'c3', title: 'Chapter 3', language: 'en' }
        ];
        const { fresh } = await store.checkForNewChapters(entry.id);
        fakeSource.getChapters = original;
        expect(fresh).toHaveLength(1);
        expect(store.listStaleEntries(90).find(item => item.id === entry.id)).toBeUndefined();
    });
});
