import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { CRAWL_BUSY_ERROR, type ImportService } from '../src/import/service.js';
import { registerImportRoutes } from '../src/routes/import.js';
import { loadPersistedQueueSettings } from '../src/routes/settings.js';
import { EventBus } from '../src/ws.js';

const importer = { start: vi.fn(async () => ({ jobId: 1 })) };

let tmpDir: string;
let database: Database;
let queue: DownloadQueue;
let app: FastifyInstance;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-import-adopt-'));
    database = new Database(tmpDir);
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
    app = Fastify();
    registerImportRoutes(app, importer as unknown as ImportService, queue, database);
});

afterAll(async () => {
    queue.stop();
    database.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('import: storage folder adoption', () => {
    it('adopts the imported folder as storage folder and persists it', async () => {
        const oldLib = path.join(tmpDir, 'old-lib');
        fs.mkdirSync(path.join(oldLib, 'Some Series'), { recursive: true });

        const response = await app.inject({ method: 'POST', url: '/api/import/jobs', payload: { path: oldLib } });
        expect(response.statusCode).toBe(200);

        expect(queue.getSettings().dataDirectory).toBe(path.resolve(oldLib));
        expect(loadPersistedQueueSettings(database).dataDirectory).toBe(path.resolve(oldLib));
        expect(importer.start).toHaveBeenCalledWith(path.resolve(oldLib), expect.anything());
    });
    it('leaves the storage folder untouched when the import is rejected (crawl busy)', async () => {
        const before = queue.getSettings().dataDirectory;
        const persistedBefore = loadPersistedQueueSettings(database).dataDirectory;
        const busyLib = path.join(tmpDir, 'busy-lib');
        fs.mkdirSync(busyLib, { recursive: true });
        importer.start.mockRejectedValueOnce(new Error(CRAWL_BUSY_ERROR));

        const response = await app.inject({ method: 'POST', url: '/api/import/jobs', payload: { path: busyLib } });
        expect(response.statusCode).toBe(400);
        expect(queue.getSettings().dataDirectory).toBe(before);
        expect(loadPersistedQueueSettings(database).dataDirectory).toBe(persistedBefore);
    });

    it('scan preview never adopts the scanned folder', async () => {
        const before = queue.getSettings().dataDirectory;
        const elsewhere = path.join(tmpDir, 'elsewhere');
        fs.mkdirSync(elsewhere, { recursive: true });

        const response = await app.inject({ method: 'POST', url: '/api/import/scan', payload: { path: elsewhere } });
        expect(response.statusCode).toBe(200);
        expect(queue.getSettings().dataDirectory).toBe(before);
    });

    it('leaves the storage folder untouched when it already matches', async () => {
        const spy = vi.spyOn(queue, 'updateSettings');
        const current = queue.getSettings().dataDirectory;
        fs.mkdirSync(path.join(current, 'Some Series'), { recursive: true });

        const response = await app.inject({ method: 'POST', url: '/api/import/jobs', payload: { path: current } });
        expect(response.statusCode).toBe(200);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('rejects an invalid path without touching the storage folder', async () => {
        const before = queue.getSettings().dataDirectory;
        const response = await app.inject({ method: 'POST', url: '/api/import/jobs', payload: { path: path.join(tmpDir, 'nope') } });
        expect(response.statusCode).toBe(400);
        expect(queue.getSettings().dataDirectory).toBe(before);
    });
});
