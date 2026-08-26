import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { classifyFailure, OUTAGE_ESCALATION_MS, OUTAGE_SILENCE_MS } from '../src/library/failover.js';
import { LibraryStore } from '../src/library/store.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let store: LibraryStore;
let queue: DownloadQueue;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

function seedFailedJob(sourceId: string, chapterId: string, autoRetries: number, failedAt: string): number {
    const result = database.db
        .prepare(
            `INSERT INTO download_jobs
            (entry_id, source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, error, auto_retries, created_at, updated_at)
            VALUES (NULL, ?, 'm', ?, 'M', ?, 'failed', 100, 5, 0, 'boom', ?, ?, ?)`
        )
        .run(sourceId, chapterId, chapterId, autoRetries, failedAt, failedAt);
    return Number(result.lastInsertRowid);
}

function jobRow(jobId: number): { status: string; auto_retries: number; updated_at: string } {
    return database.db.prepare('SELECT status, auto_retries, updated_at FROM download_jobs WHERE id = ?').get(jobId) as {
        status: string;
        auto_retries: number;
        updated_at: string;
    };
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-outage-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
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
    queue.pause(); // requeued jobs stay 'queued' so assertions are deterministic
});

afterAll(() => {
    queue.stop();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('classifyFailure', () => {
    it('treats CDN / network / timeout errors as infra', () => {
        expect(
            classifyFailure('Failed to download page "https://s2.example.xyz/res/manga/x/1.webp": non-image page (text/html;charset=utf-8, 548 bytes)')
        ).toBe('infra');
        expect(classifyFailure('Failed to download page "https://x/2.webp": HTTP 503')).toBe('infra');
        expect(classifyFailure('chapter download timed out after 20min (3/5 pages)')).toBe('infra');
        expect(classifyFailure('Failed to get page list: fetch failed')).toBe('infra');
        expect(classifyFailure(null)).toBe('infra');
        expect(classifyFailure(undefined)).toBe('infra');
    });

    it('treats server-side removals as content', () => {
        expect(classifyFailure('Failed to download page "https://x/1.webp": HTTP 404')).toBe('content');
        expect(classifyFailure('Failed to get page list: HTTP 410')).toBe('content');
        expect(classifyFailure('Failed to get page list: Page list is empty')).toBe('content');
        expect(classifyFailure('Source "x" not found')).toBe('content');
    });
});

describe('LibraryStore source outages', () => {
    it('refresh without an open outage is a no-op', () => {
        expect(store.noteSourceFailure('kali', false)).toBeUndefined();
        expect(store.getSourceOutage('kali')).toBeUndefined();
    });

    it('opens on the first flagged failure and keeps the original started_at', () => {
        const opened = store.noteSourceFailure('kali', true);
        expect(opened).toBeDefined();
        expect(opened?.failures).toBe(1);
        expect(opened?.escalatedAt).toBeNull();

        const refreshed = store.noteSourceFailure('kali', true);
        expect(refreshed?.failures).toBe(2);
        expect(refreshed?.startedAt).toBe(opened?.startedAt);
    });

    it('does not escalate a fresh outage', () => {
        expect(store.armOutageEscalation('kali')?.escalatedAt).toBeNull();
    });

    it('escalates once the outage has lasted OUTAGE_ESCALATION_MS', () => {
        database.db
            .prepare('UPDATE source_outages SET started_at = ? WHERE source_id = ?')
            .run(new Date(Date.now() - OUTAGE_ESCALATION_MS - 60_000).toISOString(), 'kali');
        expect(store.armOutageEscalation('kali')?.escalatedAt).not.toBeNull();
        // idempotent
        expect(store.armOutageEscalation('kali')?.escalatedAt).not.toBeNull();
        // a late failure refresh keeps the escalation
        expect(store.noteSourceFailure('kali', true)?.escalatedAt).not.toBeNull();
    });

    it('arms the escalation on noteSourceFailure too (jobs stopped retrying case)', () => {
        store.noteSourceFailure('fresh', true);
        database.db
            .prepare('UPDATE source_outages SET started_at = ? WHERE source_id = ?')
            .run(new Date(Date.now() - OUTAGE_ESCALATION_MS - 60_000).toISOString(), 'fresh');
        expect(store.noteSourceFailure('fresh', true)?.escalatedAt).not.toBeNull();
    });

    it('lists and closes outages', () => {
        expect(store.listSourceOutages().map(outage => outage.sourceId)).toContain('kali');
        expect(store.closeSourceOutage('kali')).toBe(true);
        expect(store.closeSourceOutage('kali')).toBe(false);
        expect(store.getSourceOutage('kali')).toBeUndefined();
    });
});

describe('exponential auto-retry backoff', () => {
    it('requeues a job whose backoff slot has elapsed, keeps deeper ones waiting', () => {
        const shallow = seedFailedJob('src', 'shallow', 0, minutesAgo(31)); // delay 30 min -> due
        const deep = seedFailedJob('src', 'deep', 2, minutesAgo(90)); // delay 2 h -> not due
        const exhausted = seedFailedJob('src', 'exhausted', 10, minutesAgo(60 * 24)); // max reached -> never

        expect(queue.sweepFailedJobs()).toBe(1);

        expect(jobRow(shallow).status).toBe('queued');
        expect(jobRow(shallow).auto_retries).toBe(1);
        expect(jobRow(deep).status).toBe('failed');
        expect(jobRow(exhausted).status).toBe('failed');
    });

    it('resetRetryLadder restarts the ladder and backdates the idle clock', () => {
        const deep = database.db.prepare("SELECT id FROM download_jobs WHERE chapter_id = 'deep'").get() as { id: number };

        expect(queue.resetRetryLadder('src')).toBeGreaterThanOrEqual(1);
        const row = jobRow(deep.id);
        expect(row.auto_retries).toBe(0);
        expect(Date.parse(row.updated_at)).toBeLessThanOrEqual(Date.now() - 29 * 60 * 1000);

        // the next sweep picks it up without waiting out the deep slot
        queue.sweepFailedJobs();
        expect(jobRow(deep.id).status).toBe('queued');
    });
});

describe('outage soft-close and reopen', () => {
    it('resumes the previous wave on a quick reopen (flap), resets a stale close', () => {
        // 'kali' was closed by the previous describe with escalatedAt armed
        const flap = store.noteSourceFailure('kali', true);
        expect(flap?.failures).toBe(1);
        expect(flap?.escalatedAt).not.toBeNull(); // the escalation survives the flap
        expect(Date.parse(flap?.startedAt ?? '')).toBeLessThan(Date.now() - OUTAGE_ESCALATION_MS);

        // a reopen after a long closed period starts a fresh clock
        store.closeSourceOutage('kali');
        database.db
            .prepare("UPDATE source_outages SET closed_at = ? WHERE source_id = 'kali'")
            .run(new Date(Date.now() - OUTAGE_SILENCE_MS - 60_000).toISOString());
        const fresh = store.noteSourceFailure('kali', true);
        expect(fresh?.escalatedAt).toBeNull();
        expect(Date.parse(fresh?.startedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    });
});
