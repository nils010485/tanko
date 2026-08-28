/**
 * Slow revalidation tier + 'lost' chapter reconciliation:
 *  - failed jobs whose fast ladder is exhausted (auto_retries >=
 *    AUTO_RETRY_MAX) are requeued once per doubling cooldown instead of being
 *    abandoned, unless the chapter is 'lost', the entry is paused/hidden, the
 *    job is an ad-hoc download (no entry) or a migration orphan;
 *  - checkForNewChapters reconciles failed/lost chapters against the source
 *    listing (removed -> 'lost', listed again -> 'failed') but never on an
 *    empty listing (takedown);
 *  - listChapters surfaces retryExhausted for the dashboard badge split.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { AUTO_RETRY_MAX, DownloadQueue } from '../src/downloader/queue.js';
import { LibraryStore } from '../src/library/store.js';
import { EventBus } from '../src/ws.js';

const HOUR_MS = 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let queue: DownloadQueue;

/** Chapter listing served by the fake source (mutated per test). */
let listing: Array<{ id: string; title: string; language?: string }> = [];

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-revalidate-'));
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
    queue = new DownloadQueue({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        events: new EventBus(),
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
    queue.pause(); // the sweep is unit-tested on rows; jobs must not run
});

afterAll(() => {
    queue.stop();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a 'failed' download job row at the given ladder state and age. */
function failedJob(entryId: number | null, chapterId: string, autoRetries: number, ageMs: number, sourceId = 'src-a'): number {
    const result = database.db
        .prepare(
            `INSERT INTO download_jobs (entry_id, source_id, manga_id, chapter_id, manga_title, chapter_title, status, auto_retries, created_at, updated_at)
             VALUES (?, ?, 'm', ?, 'Series', ?, 'failed', ?, ?, ?)`
        )
        .run(entryId, sourceId, chapterId, chapterId, autoRetries, isoAgo(ageMs), isoAgo(ageMs));
    return Number(result.lastInsertRowid);
}

const jobStatus = (id: number) =>
    (database.db.prepare('SELECT status, auto_retries AS retries FROM download_jobs WHERE id = ?').get(id) as any) ?? { status: 'gone', retries: 0 };

describe('sweepFailedJobs — slow revalidation tier', () => {
    it('requeues an exhausted job past its 24h cooldown and steps the counter', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r1', mangaId: 'm', title: 'Revalidating', backlog: 'ignore' });
        const id = failedJob(entry.id, 'c-exhausted', AUTO_RETRY_MAX, 25 * HOUR_MS, 'src-r1');
        expect(queue.sweepFailedJobs()).toBeGreaterThan(0);
        expect(jobStatus(id)).toMatchObject({ status: 'queued', retries: AUTO_RETRY_MAX + 1 });
    });

    it('keeps an exhausted job inside its cooldown slot', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r2', mangaId: 'm', title: 'Too Soon', backlog: 'ignore' });
        const id = failedJob(entry.id, 'c-too-soon', AUTO_RETRY_MAX, 2 * HOUR_MS, 'src-r2');
        queue.sweepFailedJobs();
        expect(jobStatus(id).status).toBe('failed');
    });

    it('never revalidates a chapter marked lost (removed from the listing)', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r3', mangaId: 'm', title: 'Lost Chapter', backlog: 'ignore' });
        database.db
            .prepare(
                "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, 'c-gone', 'Ch. 1', 'en', 'lost', ?)"
            )
            .run(entry.id, isoAgo(48 * HOUR_MS));
        const id = failedJob(entry.id, 'c-gone', AUTO_RETRY_MAX, 48 * HOUR_MS, 'src-r3');
        queue.sweepFailedJobs();
        expect(jobStatus(id).status).toBe('failed');
    });

    it('skips paused entries and ad-hoc jobs without an entry', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r4', mangaId: 'm', title: 'Paused Series', backlog: 'ignore' });
        store.setPaused(entry.id, true);
        const pausedJob = failedJob(entry.id, 'c-paused', AUTO_RETRY_MAX, 48 * HOUR_MS, 'src-r4');
        const adhocJob = failedJob(null, 'c-adhoc', AUTO_RETRY_MAX, 48 * HOUR_MS);
        queue.sweepFailedJobs();
        expect(jobStatus(pausedJob).status).toBe('failed');
        expect(jobStatus(adhocJob).status).toBe('failed');
    });

    it('keeps the fast ladder working and filters migration orphans', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r5', mangaId: 'm', title: 'Fast And Orphan', backlog: 'ignore' });
        // fast tier: 2 retries consumed -> 2h backoff, elapsed
        const fast = failedJob(entry.id, 'c-fast', 2, 3 * HOUR_MS, 'src-r5');
        // orphan: the entry migrated away from the job's source
        const orphan = failedJob(entry.id, 'c-orphan', 2, 3 * HOUR_MS, 'src-dead');
        queue.sweepFailedJobs();
        expect(jobStatus(fast)).toMatchObject({ status: 'queued', retries: 3 });
        expect(jobStatus(orphan).status).toBe('failed');
    });

    it('doubles the revalidation cooldown per step and caps it at 7 days', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r6', mangaId: 'm', title: 'Cooldowns', backlog: 'ignore' });
        // 2 steps consumed -> 48h cooldown: 47h old stays, 49h old requeues
        const tooSoon = failedJob(entry.id, 'c-48h-soon', AUTO_RETRY_MAX + 1, 47 * HOUR_MS, 'src-r6');
        const due = failedJob(entry.id, 'c-48h-due', AUTO_RETRY_MAX + 1, 49 * HOUR_MS, 'src-r6');
        queue.sweepFailedJobs();
        expect(jobStatus(tooSoon).status).toBe('failed');
        expect(jobStatus(due).status).toBe('queued');

        // deep steps -> 7-day cap: 8 days old requeues
        const capped = failedJob(entry.id, 'c-capped', AUTO_RETRY_MAX + 5, 8 * 24 * HOUR_MS, 'src-r6');
        queue.sweepFailedJobs();
        expect(jobStatus(capped)).toMatchObject({ status: 'queued', retries: AUTO_RETRY_MAX + 6 });
    });

    it('never revalidates an exhausted migration orphan', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r7', mangaId: 'm', title: 'Orphan Slow', backlog: 'ignore' });
        const id = failedJob(entry.id, 'c-orphan-slow', AUTO_RETRY_MAX, 48 * HOUR_MS, 'src-dead-2');
        queue.sweepFailedJobs();
        expect(jobStatus(id).status).toBe('failed');
    });

    it('resumes a revived lost chapter: check flips it failed, sweep requeues its job', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-r8', mangaId: 'm', title: 'Revived', backlog: 'ignore' });
        database.db
            .prepare(
                "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, 'c-back-slow', 'Ch. 4', 'en', 'lost', ?)"
            )
            .run(entry.id, isoAgo(48 * HOUR_MS));
        const id = failedJob(entry.id, 'c-back-slow', AUTO_RETRY_MAX, 48 * HOUR_MS, 'src-r8');
        listing = [{ id: 'c-back-slow', title: 'Ch. 4' }];
        await store.checkForNewChapters(entry.id);
        expect(store.listChapters(entry.id).find(chapter => chapter.chapterId === 'c-back-slow')?.status).toBe('failed');
        queue.sweepFailedJobs();
        expect(jobStatus(id).status).toBe('queued');
    });
});

describe('checkForNewChapters — failed/lost reconciliation', () => {
    it('marks unlisted failed chapters lost and revives listed lost ones', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-b', mangaId: 'm', title: 'Reconcile', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, 'en', ?, ?)"
        );
        insert.run(entry.id, 'c-stayed', 'Ch. 1', 'failed', isoAgo(48 * HOUR_MS));
        insert.run(entry.id, 'c-removed', 'Ch. 2', 'failed', isoAgo(48 * HOUR_MS));
        insert.run(entry.id, 'c-back', 'Ch. 3', 'lost', isoAgo(48 * HOUR_MS));

        listing = [
            { id: 'c-stayed', title: 'Ch. 1' },
            { id: 'c-back', title: 'Ch. 3' },
            { id: 'c-new', title: 'Ch. 9' }
        ];
        const { fresh } = await store.checkForNewChapters(entry.id);
        expect(fresh.map(chapter => chapter.chapter_id)).toEqual(['c-new']);

        const statuses = Object.fromEntries(store.listChapters(entry.id).map(chapter => [chapter.chapterId, chapter.status]));
        expect(statuses).toMatchObject({ 'c-stayed': 'failed', 'c-removed': 'lost', 'c-back': 'failed', 'c-new': 'new' });
    });

    it('never mass-marks chapters lost on an empty listing (takedown)', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-c', mangaId: 'm', title: 'Takedown', backlog: 'ignore' });
        database.db
            .prepare(
                "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, 'c-keep', 'Ch. 1', 'en', 'failed', ?)"
            )
            .run(entry.id, isoAgo(48 * HOUR_MS));
        listing = [];
        await store.checkForNewChapters(entry.id);
        expect(store.listChapters(entry.id).find(chapter => chapter.chapterId === 'c-keep')?.status).toBe('failed');
    });

    it('leaves queued and downloading chapters alone during reconciliation', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-e', mangaId: 'm', title: 'In Flight', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, 'en', ?, ?)"
        );
        insert.run(entry.id, 'c-queued', 'Ch. 1', 'queued', isoAgo(48 * HOUR_MS));
        insert.run(entry.id, 'c-dling', 'Ch. 2', 'downloading', isoAgo(48 * HOUR_MS));
        listing = [{ id: 'other', title: 'Ch. 9' }];
        await store.checkForNewChapters(entry.id);
        const statuses = Object.fromEntries(store.listChapters(entry.id).map(chapter => [chapter.chapterId, chapter.status]));
        expect(statuses).toMatchObject({ 'c-queued': 'queued', 'c-dling': 'downloading' });
    });
});

describe('listChapters — retryExhausted badge flag', () => {
    it('flags chapters whose job exhausted the fast ladder', async () => {
        const { entry } = await store.addEntry({ sourceId: 'src-d', mangaId: 'm', title: 'Exhausted', backlog: 'ignore' });
        const insert = database.db.prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, 'en', 'failed', ?)"
        );
        insert.run(entry.id, 'c-exhausted', 'Ch. 1', isoAgo(48 * HOUR_MS));
        insert.run(entry.id, 'c-fresh-fail', 'Ch. 2', isoAgo(48 * HOUR_MS));
        failedJob(entry.id, 'c-exhausted', AUTO_RETRY_MAX, 25 * HOUR_MS, 'src-d');
        failedJob(entry.id, 'c-fresh-fail', 2, 3 * HOUR_MS, 'src-d');

        const chapters = Object.fromEntries(store.listChapters(entry.id).map(chapter => [chapter.chapterId, chapter.retryExhausted]));
        expect(chapters['c-exhausted']).toBe(true);
        expect(chapters['c-fresh-fail']).toBeUndefined();
    });
});
