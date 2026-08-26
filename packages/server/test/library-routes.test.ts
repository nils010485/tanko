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

// Boots the real route table on a real Fastify instance: Fastify throws
// FST_ERR_DUPLICATED_ROUTE at ready() when the same method+URL is declared
// twice — exactly the crash the Docker image hit once, which neither tsc
// nor the store tests could catch.
let tmpDir: string;
let database: Database;

const fakeRegistry = { get: async () => undefined, list: async () => [] };

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-routes-'));
    database = new Database(tmpDir);
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('library route table', () => {
    it('registers without duplicated method+URL', async () => {
        const app = Fastify();
        const events = new EventBus();
        const settings = {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source' as const,
            chapterFormat: 'cbz' as const,
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        };
        const store = new LibraryStore({ db: database, registry: fakeRegistry as never, queueSettings: settings });
        const queue = new DownloadQueue({ db: database, registry: fakeRegistry as never, events, settings });
        const scheduler = new Scheduler({ db: database, store, queue, events });
        registerLibraryRoutes(app, store, scheduler, queue, events);
        await expect(app.ready()).resolves.toBeDefined();
        await app.close();
    });
});
