import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { readUiLanguage, registerSettingsRoutes } from '../src/routes/settings.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let queue: DownloadQueue;
let app: FastifyInstance;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-settings-'));
    database = new Database(tmpDir);
    queue = new DownloadQueue({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        events: new EventBus(),
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
            concurrency: 1,
            throttleMs: 0
        }
    });
    app = Fastify();
    registerSettingsRoutes(app, queue, database);
});

afterAll(async () => {
    queue.stop();
    database.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('settings: ui language', () => {
    it('defaults to English when nothing is persisted', async () => {
        expect(readUiLanguage(database)).toBe('en');
        const response = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(response.statusCode).toBe(200);
        expect(response.json().uiLanguage).toBe('en');
    });

    it('persists a valid language and serves it back', async () => {
        const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { uiLanguage: 'fr' } });
        expect(response.statusCode).toBe(200);
        expect(response.json().uiLanguage).toBe('fr');
        expect(readUiLanguage(database)).toBe('fr');

        await app.inject({ method: 'PATCH', url: '/api/settings', payload: { uiLanguage: 'en' } });
        expect(readUiLanguage(database)).toBe('en');
    });

    it('rejects an unknown language', async () => {
        const response = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { uiLanguage: 'de' } });
        expect(response.statusCode).toBe(400);
        expect(readUiLanguage(database)).toBe('en');
    });

    it('ignores corrupt persisted values (falls back to English)', async () => {
        database.kvSet('ui-language', 'klingon');
        expect(readUiLanguage(database)).toBe('en');
    });
});
