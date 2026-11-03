/**
 * Proxy settings: validation on PATCH, persistence, and the live dispatcher
 * swap (no restart, the previous tunnel is closed).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProxySettingsDto } from '@tanko/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import type { DownloadQueue } from '../src/downloader/queue.js';
import { readProxySettings, registerSettingsRoutes } from '../src/routes/settings.js';
import { activeProxy, applyProxy } from '../src/util/proxy.js';

const queue = {
    getSettings: () => ({
        dataDirectory: '/tmp/tanko-proxy-test',
        directoryLayout: 'series',
        chapterFormat: 'cbz',
        parallelSources: 2,
        concurrencyPerSource: 2,
        throttleMs: 250,
        historyRetentionDays: 30
    }),
    updateSettings: () => queue.getSettings()
};

let tmpDir: string;
let database: Database;
let app: FastifyInstance;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-proxy-'));
    database = new Database(tmpDir);
    app = Fastify();
    registerSettingsRoutes(app, queue as unknown as DownloadQueue, database);
    await app.ready();
});

afterAll(async () => {
    await applyProxy({ enabled: false, url: '' });
    database.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const patch = (proxy: Partial<ProxySettingsDto>) => app.inject({ method: 'PATCH', url: '/api/settings', payload: { proxy } });

describe('proxy settings', () => {
    it('defaults to a direct connection', async () => {
        const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
        expect(body.proxy).toEqual({ enabled: false, url: '' });
    });

    it('rejects a URL it cannot parse, and keeps the previous value', async () => {
        const refused = await patch({ enabled: true, url: 'ftp://proxy.example:21' });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error).toMatch(/Unsupported proxy scheme/);
        expect(readProxySettings(database)).toEqual({ enabled: false, url: '' });
    });

    it('rejects a non-boolean flag', async () => {
        const refused = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { proxy: { enabled: 'yes' } } });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error).toMatch(/proxy\.enabled/);
    });

    it('persists the proxy and activates it live', async () => {
        const accepted = await patch({ enabled: true, url: ' socks5h://bot:s3cret@127.0.0.1:1080 ' });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json().proxy).toEqual({ enabled: true, url: 'socks5h://bot:s3cret@127.0.0.1:1080' });
        expect(readProxySettings(database).enabled).toBe(true);
        expect(activeProxy()).toBe('socks5h://bot:s3cret@127.0.0.1:1080');
    });

    it('clears the proxy when disabled', async () => {
        await patch({ enabled: false });
        expect(readProxySettings(database)).toEqual({ enabled: false, url: 'socks5h://bot:s3cret@127.0.0.1:1080' });
        expect(activeProxy()).toBeNull();
    });
});
