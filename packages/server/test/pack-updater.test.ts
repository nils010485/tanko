import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { getPackStatus, SOURCES_PACK_KEY, syncSourcesPack, validatePack } from '../src/sources/pack-updater.js';

let dataDir: string;
let database: Database;
let server: http.Server | undefined;
let baseUrl: string;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-pack-'));
    database = new Database(dataDir);
});

afterEach(async () => {
    database.close();
    await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
});

function servePack(...packs: unknown[]): Promise<void> {
    let index = 0;
    return new Promise(resolve => {
        server = http.createServer((_request, response) => {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(packs[Math.min(index++, packs.length - 1)]));
        });
        server.listen(0, '127.0.0.1', () => {
            baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
            resolve();
        });
    });
}

describe('validatePack', () => {
    it('accepts a valid pack', () => {
        const pack = validatePack({
            version: '2026-09-30',
            sources: { toonily: { base: 'https://example.org' }, x: { tags: ['a', 'b'], selectors: { row: '.a' } } }
        });
        expect(pack.version).toBe('2026-09-30');
    });

    it('rejects bad shapes and non-https url keys', () => {
        expect(() => validatePack({ version: '', sources: {} })).toThrow();
        expect(() => validatePack({ version: 'v1', sources: [] })).toThrow();
        expect(() => validatePack({ version: 'v1', sources: { a: { base: 'http://insecure.example' } } })).toThrow();
        expect(() => validatePack({ version: 'v1', sources: { a: { deep: { nope: { x: 1 } } } } })).toThrow();
    });
});

describe('syncSourcesPack', () => {
    it('applies a new version and skips an already applied one', async () => {
        await servePack({ version: 'v1', sources: { toonily: { base: 'https://example.org' } } });
        const first = await syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl });
        expect(first.applied).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'sources-overrides.json'), 'utf8'))).toEqual({
            sources: { toonily: { base: 'https://example.org' } }
        });
        expect(getPackStatus(database).last?.version).toBe('v1');

        const second = await syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl });
        expect(second.applied).toBe(false);
        expect(database.kvGet(SOURCES_PACK_KEY)).toContain('v1');
    });

    it('applies a newer version over an older one', async () => {
        await servePack(
            { version: 'v1', sources: { toonily: { base: 'https://v1.example' } } },
            { version: 'v2', sources: { toonily: { base: 'https://v2.example' } } }
        );
        await syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl });
        const second = await syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl });
        expect(second.applied).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'sources-overrides.json'), 'utf8')).sources.toonily.base).toBe('https://v2.example');
        expect(getPackStatus(database).last?.version).toBe('v2');
    });

    it('keeps the current file when the fetched pack is invalid', async () => {
        await servePack({ version: 'v1', sources: { toonily: { base: 'https://example.org' } } });
        await syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl });
        await servePack({ version: 'v2', sources: { bad: { base: 'http://nope' } } });
        await expect(syncSourcesPack({ dataDirectory: dataDir, db: database, url: baseUrl })).rejects.toThrow();
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'sources-overrides.json'), 'utf8')).sources.toonily.base).toBe('https://example.org');
    });
});
