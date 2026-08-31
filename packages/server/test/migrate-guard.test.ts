import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { LibraryStore } from '../src/library/store.js';
import { registerLibraryRoutes } from '../src/routes/library.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { EventBus } from '../src/ws.js';

// POST /api/library/:id/migrate must refuse to run while the entry still has
// queued/downloading jobs — the same guard as /rematch/confirm. Migrating
// under running downloads orphans their files (written to the old source's
// folder, never attached to the rebuilt chapter rows).
let tmpDir: string;
let database: Database;
let store: LibraryStore;
let queue: DownloadQueue;
let scheduler: Scheduler;
let app: ReturnType<typeof Fastify>;

const adapters: Record<string, { label: string; getChapters: () => Promise<Array<{ id: string; title: string; language: string }>> }> = {
    old: {
        label: 'Old',
        getChapters: async () => [{ id: 'o1', title: 'Chapter 1', language: 'en' }]
    },
    fresh: {
        label: 'Fresh',
        getChapters: async () => [
            { id: 'f1', title: 'Chapter 1', language: 'en' },
            { id: 'f2', title: 'Chapter 2', language: 'en' }
        ]
    }
};

const registry = {
    get: async (id: string) => adapters[id],
    list: async () => []
};

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-migrate-guard-'));
    database = new Database(tmpDir);
    const settings = {
        dataDirectory: path.join(tmpDir, 'downloads'),
        directoryLayout: 'source' as const,
        chapterFormat: 'cbz' as const,
        parallelSources: 1,
        concurrencyPerSource: 1,
        throttleMs: 0
    };
    store = new LibraryStore({ db: database, registry: registry as never, queueSettings: settings });
    const events = new EventBus();
    queue = new DownloadQueue({ db: database, registry: registry as never, events, settings });
    scheduler = new Scheduler({ db: database, store, queue, events });
    app = Fastify();
    registerLibraryRoutes(app, store, scheduler, queue, events);
    await app.ready();
});

afterAll(async () => {
    queue.stop();
    scheduler.stop();
    await app.close();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/library/:entryId/migrate under running downloads', () => {
    it('answers 409 while a queued job exists, migrates once it is gone', async () => {
        const { entry } = await store.addEntry({ sourceId: 'old', mangaId: 'm1', title: 'Guarded', backlog: 'grab' });
        expect(entry.sourceId).toBe('old');

        // a pending job for the entry (paused queue keeps it 'queued')
        queue.pause();
        queue.enqueue([{ sourceId: 'old', mangaId: 'm1', mangaTitle: 'Guarded', chapterId: 'o1', chapterTitle: 'Chapter 1', entryId: entry.id }]);
        expect(queue.hasPendingJobs(entry.id)).toBe(true);

        const target = { sourceId: 'fresh', sourceLabel: 'Fresh', mangaId: 'm2', mangaTitle: 'Guarded' };
        const conflict = await app.inject({ method: 'POST', url: `/api/library/${entry.id}/migrate`, payload: target });
        expect(conflict.statusCode).toBe(409);

        // the job settles (finishes or is dismissed): the guard opens
        database.db.prepare('DELETE FROM download_jobs WHERE entry_id = ?').run(entry.id);
        const applied = await app.inject({ method: 'POST', url: `/api/library/${entry.id}/migrate`, payload: target });
        expect(applied.statusCode).toBe(200);
        expect(applied.json()).toMatchObject({ total: 2 });
        expect(store.getEntry(entry.id)?.sourceId).toBe('fresh');
    });
});
