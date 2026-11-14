/**
 * Proves the connector-worker mechanism: a legacy-style connector parses HTML
 * (linkedom, synchronous) in a separate process, every one of its fetches is
 * proxied back to the main-side session, and the pool recycles workers on
 * timeout and kills them on dispose.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorPool } from '../src/shims/connector-pool.js';
import { HeadlessRequest } from '../src/shims/request.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures/fixture-connector.mjs');
const PAGE_URL = 'https://fixture.invalid/chapter/1';
const PAGE_HTML = `<!doctype html><html><body>
<img class="page" src="https://cdn.fixture.invalid/01.jpg">
<img class="page" src="https://cdn.fixture.invalid/02.jpg">
</body></html>`;

const MANGA = { id: 'manga-1', title: 'Fixture Manga' };
const CHAPTER = { id: '1', title: 'Chapter 1' };

function stubPageFetch() {
    const mock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    );
    vi.stubGlobal('fetch', mock);
    return mock;
}

describe('ConnectorPool', () => {
    let pool: ConnectorPool | undefined;

    afterEach(async () => {
        await pool?.dispose();
        pool = undefined;
        vi.unstubAllGlobals();
    });

    it('parses in the worker and proxies its fetch to the main session', async () => {
        const fetchMock = stubPageFetch();
        pool = new ConnectorPool({ request: new HeadlessRequest(), size: 1 });

        const pages = await pool.run<string[]>('fixture', FIXTURE, 'getPages', [MANGA, CHAPTER]);
        expect(pages).toEqual(['https://cdn.fixture.invalid/01.jpg', 'https://cdn.fixture.invalid/02.jpg']);
        // the worker's fetch went through the main-side transport
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe(PAGE_URL);

        // the fixture reports the pid of the process that ran the linkedom parse
        const mangas = await pool.run<Array<{ id: string; title: string }>>('fixture', FIXTURE, 'searchMangas', ['']);
        expect(mangas).toHaveLength(1);
        const parsePid = Number(mangas[0].id);
        expect(parsePid).toBeGreaterThan(0);
        expect(parsePid).not.toBe(process.pid);
    });

    it('recycles the worker when an operation times out', async () => {
        stubPageFetch();
        pool = new ConnectorPool({ request: new HeadlessRequest(), size: 1, opTimeoutMs: 500 });

        const before = await pool.run<Array<{ id: string }>>('fixture', FIXTURE, 'searchMangas', ['']);
        await expect(pool.run('fixture', FIXTURE, 'getPages', [MANGA, { id: 'hang', title: 'Hang' }])).rejects.toThrow(/timed out/);
        const after = await pool.run<Array<{ id: string }>>('fixture', FIXTURE, 'searchMangas', ['']);

        expect(Number(after[0].id)).not.toBe(Number(before[0].id));
        expect(Number(after[0].id)).not.toBe(process.pid);
    });

    it('kills every worker on dispose', async () => {
        stubPageFetch();
        pool = new ConnectorPool({ request: new HeadlessRequest(), size: 2 });

        const results = await Promise.all([
            pool.run<Array<{ id: string }>>('fixture-a', FIXTURE, 'searchMangas', ['']),
            pool.run<Array<{ id: string }>>('fixture-b', FIXTURE, 'searchMangas', [''])
        ]);
        const workerPids = results.map(([manga]) => Number(manga.id));
        expect(new Set(workerPids).size).toBe(2);

        await pool.dispose();
        await expect(pool.run('fixture-a', FIXTURE, 'searchMangas', [''])).rejects.toThrow(/disposed/);
        for (const pid of workerPids) {
            expect(() => process.kill(pid, 0)).toThrow();
        }
    });
});
