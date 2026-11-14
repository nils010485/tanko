/**
 * Proves the legacy adapter delegates its list operations to the engine's
 * connector pool (legacy-adapter.ts -> connector-pool.ts), that connector://
 * routing goes through the same workers, and that TANKO_CONNECTOR_INPROCESS
 * keeps the in-process path alive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEngine, getConnectorPool, loadConnectors } from '../src/engine.js';
import { SourceRegistry } from '../src/sources/registry.js';
import type { SourceAdapter } from '../src/sources/types.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/fixture-connector.mjs');
const PAGE_HTML = `<!doctype html><html><body>
<img class="page" src="https://cdn.fixture.invalid/01.jpg">
<img class="page" src="https://cdn.fixture.invalid/02.jpg">
</body></html>`;
/** Root pages must not look like an anti-bot shell (>= 1 kB of content). */
const ROOT_HTML = `<html><body>${'<p>catalog filler</p>'.repeat(200)}<a href="/manga/1">Manga 1</a></body></html>`;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes('/chapter/') ? PAGE_HTML : ROOT_HTML;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
});

let dataDirectory: string;
let adapter: SourceAdapter;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-legacy-pool-'));
    const connectors = path.join(dataDirectory, 'vendor', 'connectors');
    fs.mkdirSync(connectors, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(connectors, 'Fixture.mjs'));
    // before createEngine: the engine captures the transport into its fetch wrapper
    globalThis.fetch = fetchMock as typeof fetch;
    await createEngine({ dataDirectory });
    await loadConnectors();
    const source = await new SourceRegistry().get('fixture');
    if (!source) {
        throw new Error('fixture connector not registered');
    }
    adapter = source;
});

afterAll(async () => {
    await getConnectorPool()?.dispose();
    globalThis.fetch = originalFetch;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
});

describe('legacy adapter connector pool', () => {
    it('runs list operations in a worker, fed by the main-side session', async () => {
        const mangas = await adapter.searchMangas('');
        expect(mangas).toHaveLength(1);
        expect(Number(mangas[0].id)).not.toBe(process.pid);

        const chapters = await adapter.getChapters(mangas[0]);
        expect(chapters).toEqual([{ id: '1', title: 'Chapter 1', language: undefined }]);

        const pages = await adapter.getPages(mangas[0], chapters[0]);
        expect(pages).toEqual(['https://cdn.fixture.invalid/01.jpg', 'https://cdn.fixture.invalid/02.jpg']);
        expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain('https://fixture.invalid/chapter/1');
    });

    it('routes connector:// through a worker', async () => {
        const response = await fetch('connector://fixture/media');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/png');
        const body = Buffer.from(await response.arrayBuffer()).toString();
        expect(body).toMatch(/^uri-from-\d+$/);
        expect(body).not.toBe(`uri-from-${process.pid}`);
    });

    it('offloads the health check catalog crawl', async () => {
        await expect(adapter.checkHealth()).resolves.toMatchObject({ ok: true });
    });

    it('keeps the in-process path behind TANKO_CONNECTOR_INPROCESS', async () => {
        process.env.TANKO_CONNECTOR_INPROCESS = '1';
        try {
            const mangas = await adapter.searchMangas('');
            expect(Number(mangas[0].id)).toBe(process.pid);
        } finally {
            delete process.env.TANKO_CONNECTOR_INPROCESS;
        }
    });
});
