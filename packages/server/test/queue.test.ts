import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { EventBus } from '../src/ws.js';

// A tiny 1x1 PNG served by a local HTTP server stands in for a real source.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let database: Database;
let queue: DownloadQueue;

const fakeSource = {
    id: 'test-source',
    label: 'Test Source',
    tags: ['test'],
    kind: 'native',
    url: undefined,
    initialize: async () => undefined,
    searchMangas: async () => [],
    getChapters: async () => [],
    getPages: async () => [`${baseUrl}/page1.png`, `${baseUrl}/page2.png`, `${baseUrl}/page3.png`],
    checkHealth: async () => ({ ok: true, latencyMs: 1 })
};

// Sources whose getPages waits until the test opens the gate: the scheduler
// marks their jobs "downloading" but they never finish, so tests can observe
// the steady-state concurrency per source.
let gateOpen = false;
const gateWaiters: Array<() => void> = [];
const openGate = () => {
    gateOpen = true;
    for (const waiter of gateWaiters.splice(0)) {
        waiter();
    }
};
const gatedSource = (id: string, label: string) => ({
    ...fakeSource,
    id,
    label,
    getPages: async () => {
        if (!gateOpen) {
            await new Promise<void>(resolve => gateWaiters.push(resolve));
        }
        return [`${baseUrl}/page1.png`];
    }
});
const gatedA = gatedSource('gated-a', 'Gated A');
const gatedB = gatedSource('gated-b', 'Gated B');
const sourcesById: Record<string, unknown> = { 'test-source': fakeSource, 'gated-a': gatedA, 'gated-b': gatedB };
const fakeRegistry: any = {
    get: async (id: string) => sourcesById[id],
    list: async () => [fakeSource]
};

function waitForJob(jobId: number, statuses: string[], timeoutMs = 20000): Promise<any> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const row = database.db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId) as any;
            if (row && statuses.includes(row.status)) {
                clearInterval(timer);
                resolve(row);
            } else if (Date.now() - startedAt > timeoutMs) {
                clearInterval(timer);
                reject(new Error(`Job ${jobId} did not reach ${statuses.join('|')} in time (status: ${row?.status})`));
            }
        }, 200);
    });
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
    server = http.createServer((_, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-test-'));
    database = new Database(tmpDir);
    queue = new DownloadQueue({
        db: database,
        registry: fakeRegistry,
        events: new EventBus(),
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            chapterFormat: 'img',
            parallelSources: 1,
            concurrencyPerSource: 2,
            throttleMs: 10
        }
    });
});

afterAll(async () => {
    queue.stop();
    database.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DownloadQueue', () => {
    it('downloads a chapter and marks it completed', async () => {
        const { added } = queue.enqueue([
            {
                sourceId: 'test-source',
                mangaId: 'manga-1',
                mangaTitle: 'Test Manga',
                chapterId: 'chapter-1',
                chapterTitle: 'Chapter 1'
            }
        ]);
        expect(added).toBe(1);

        const row = await waitForJob(1, ['completed']);
        expect(row.pages_total).toBe(3);
        expect(row.pages_done).toBe(3);

        const directory = path.join(tmpDir, 'downloads', 'Test Source', 'Test Manga', 'Chapter 1');
        const files = fs.readdirSync(directory).sort();
        expect(files).toEqual(['1.png', '2.png', '3.png']);
    });

    it('deduplicates identical chapters', () => {
        const result = queue.enqueue([
            {
                sourceId: 'test-source',
                mangaId: 'manga-1',
                mangaTitle: 'Test Manga',
                chapterId: 'chapter-1',
                chapterTitle: 'Chapter 1'
            }
        ]);
        expect(result.added).toBe(0);
        expect(result.skipped).toBe(1);
    });

    it('fails cleanly for an unknown source', async () => {
        queue.enqueue([
            {
                sourceId: 'missing-source',
                mangaId: 'manga-x',
                mangaTitle: 'Ghost',
                chapterId: 'chapter-x',
                chapterTitle: 'Chapter X'
            }
        ]);
        const rows = database.db.prepare('SELECT * FROM download_jobs WHERE source_id = ?').all('missing-source') as any[];
        const row = await waitForJob(rows[0].id, ['failed']);
        expect(row.error).toContain('not found');
    });

    it('requeues failed jobs via enqueue', async () => {
        queue.pause();
        const before = database.db.prepare('SELECT status FROM download_jobs WHERE source_id = ?').get('missing-source') as any;
        expect(before.status).toBe('failed');
        const result = queue.enqueue([
            {
                sourceId: 'missing-source',
                mangaId: 'manga-x',
                mangaTitle: 'Ghost',
                chapterId: 'chapter-x',
                chapterTitle: 'Chapter X'
            }
        ]);
        expect(result.retried).toBe(1);
        const after = database.db.prepare('SELECT status FROM download_jobs WHERE source_id = ?').get('missing-source') as any;
        expect(after.status).toBe('queued');
        queue.resume();
    });

    it('cancels a queued job', async () => {
        queue.pause();
        queue.enqueue([
            {
                sourceId: 'test-source',
                mangaId: 'manga-1',
                mangaTitle: 'Test Manga',
                chapterId: 'chapter-cancel',
                chapterTitle: 'Chapter Cancel'
            }
        ]);
        const rows = database.db.prepare('SELECT * FROM download_jobs WHERE chapter_id = ?').all('chapter-cancel') as any[];
        expect(queue.cancel(rows[0].id)).toBe(true);
        const row = await waitForJob(rows[0].id, ['cancelled']);
        expect(row.status).toBe('cancelled');
        queue.resume();
    });

    it('skips chapters whose output already exists', async () => {
        // pre-create the chapter directory with a file -> job completes without downloading
        const directory = path.join(tmpDir, 'downloads', 'Test Source', 'Test Manga', 'Chapter Existing');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, '01.png'), PNG);

        queue.enqueue([
            {
                sourceId: 'test-source',
                mangaId: 'manga-1',
                mangaTitle: 'Test Manga',
                chapterId: 'chapter-existing',
                chapterTitle: 'Chapter Existing'
            }
        ]);
        const rows = database.db.prepare('SELECT * FROM download_jobs WHERE chapter_id = ?').all('chapter-existing') as any[];
        await waitForJob(rows[0].id, ['completed']);
        // the shortcut must NOT have downloaded: only the pre-created file remains
        expect(fs.readdirSync(directory)).toEqual(['01.png']);
    });

    it('prunes finished jobs older than the retention, keeps recent and active ones', () => {
        const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        database.db
            .prepare(
                `INSERT INTO download_jobs
                (source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, created_at, updated_at)
             VALUES ('old-source', 'old-manga', 'old-chapter', 'Old', 'Old Ch', 'completed', 1, 1, 1, ?, ?)`
            )
            .run(old, old);
        const settings = queue.updateSettings({ historyRetentionDays: 30 });
        expect(settings.historyRetentionDays).toBe(30);
        const pruned = database.db.prepare('SELECT COUNT(*) AS n FROM download_jobs WHERE source_id = ?').get('old-source') as any;
        expect(pruned.n).toBe(0);
        const recent = database.db.prepare('SELECT COUNT(*) AS n FROM download_jobs WHERE source_id = ?').get('test-source') as any;
        expect(recent.n).toBeGreaterThan(0);
        queue.updateSettings({ historyRetentionDays: 0 });
    });

    it('clearHistory removes finished jobs only', async () => {
        queue.pause();
        queue.enqueue([
            {
                sourceId: 'test-source',
                mangaId: 'manga-clear',
                mangaTitle: 'Clear Manga',
                chapterId: 'chapter-queued',
                chapterTitle: 'Chapter Queued'
            }
        ]);
        const removed = queue.clearHistory();
        expect(removed).toBeGreaterThan(0);
        const finished = database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE status IN ('completed', 'failed', 'cancelled')").get() as any;
        expect(finished.n).toBe(0);
        const queued = database.db.prepare('SELECT status FROM download_jobs WHERE chapter_id = ?').get('chapter-queued') as any;
        expect(queued.status).toBe('queued');
        queue.resume();
        await waitForJob((database.db.prepare('SELECT id FROM download_jobs WHERE chapter_id = ?').get('chapter-queued') as any).id, ['completed']);
    });

    it('clearQueue removes queued jobs, flags downloading ones, keeps history', () => {
        queue.pause();
        queue.enqueue([
            { sourceId: 'test-source', mangaId: 'manga-cq', mangaTitle: 'CQ Manga', chapterId: 'chapter-cq-1', chapterTitle: 'Chapter CQ 1' },
            { sourceId: 'test-source', mangaId: 'manga-cq', mangaTitle: 'CQ Manga', chapterId: 'chapter-cq-2', chapterTitle: 'Chapter CQ 2' }
        ]);
        const now = new Date().toISOString();
        database.db
            .prepare(
                `INSERT INTO download_jobs
                (source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, created_at, updated_at)
             VALUES ('dl-source', 'dl-manga', 'dl-chapter', 'DL', 'DL Ch', 'downloading', 0, 3, 0, ?, ?)`
            )
            .run(now, now);

        const result = queue.clearQueue();
        expect(result.removed).toBe(2);
        expect(result.cancelled).toBe(1);

        const queued = database.db.prepare('SELECT COUNT(*) AS n FROM download_jobs WHERE chapter_id LIKE ?').get('chapter-cq-%') as any;
        expect(queued.n).toBe(0);
        const downloading = database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE source_id = 'dl-source'").get() as any;
        expect(downloading.n).toBe(1);
        const history = database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE status = 'completed'").get() as any;
        expect(history.n).toBeGreaterThan(0);
        queue.resume();
    });

    it('runs parallelSources × concurrencyPerSource jobs spread across sources', async () => {
        queue.pause();
        queue.updateSettings({ parallelSources: 2, concurrencyPerSource: 2 });
        queue.enqueue([
            ...[1, 2, 3].map(n => ({ sourceId: 'gated-a', mangaId: 'gated', mangaTitle: 'Gated', chapterId: `ga-${n}`, chapterTitle: `GA ${n}` })),
            ...[1, 2, 3].map(n => ({ sourceId: 'gated-b', mangaId: 'gated', mangaTitle: 'Gated', chapterId: `gb-${n}`, chapterTitle: `GB ${n}` }))
        ]);
        queue.resume(); // schedules synchronously: 2 chapters per gated source start now
        await sleep(300); // let the started jobs settle inside getPages

        const downloading = (source: string) =>
            (database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE source_id = ? AND status = 'downloading'").get(source) as any).n;
        expect(downloading('gated-a')).toBe(2);
        expect(downloading('gated-b')).toBe(2);
        const queued = database.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE chapter_id IN ('ga-3', 'gb-3') AND status = 'queued'").get() as any;
        expect(queued.n).toBe(2);

        openGate(); // releases the 4 running jobs; the 2 queued ones then start and pass through
        queue.updateSettings({ parallelSources: 1, concurrencyPerSource: 2 }); // restore the other tests' behavior
        for (const row of database.db.prepare("SELECT id FROM download_jobs WHERE chapter_id LIKE 'g%'").all() as any[]) {
            await waitForJob(row.id, ['completed']);
        }
    });
});
