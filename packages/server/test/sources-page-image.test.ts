/**
 * Page-image proxy route: byte-budget cache, the source's own browser-session
 * transport, and the per-host concurrency cap that keeps a chapter preview
 * from saturating the browser's connection pool / storming a CDN.
 */
import type { SourceAdapter } from '@tanko/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSourceRoutes } from '../src/routes/sources.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Any hostname resolves to a public address: the SSRF guard passes without network.
vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }));

/** Boot the real source routes against a fake registry returning `adapter`. */
function boot(adapter: SourceAdapter | undefined): FastifyInstance {
    const app = Fastify();
    const registry = { get: async () => adapter, list: async () => [] } as never;
    registerSourceRoutes(
        app,
        registry,
        () => [],
        () => false
    );
    return app;
}

const pageImage = (app: FastifyInstance, url: string, sourceId = 'native') =>
    app.inject({ method: 'GET', url: `/api/sources/${sourceId}/page-image?url=${encodeURIComponent(url)}` });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('page-image route', () => {
    it('rejects a missing url with 400', async () => {
        const app = boot(undefined);
        const response = await app.inject({ method: 'GET', url: '/api/sources/native/page-image' });
        expect(response.statusCode).toBe(400);
        await app.close();
    });

    it('serves a cached copy on the second request without re-fetching', async () => {
        const fetchMock = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('fetch', fetchMock);
        const app = boot({ id: 'native', label: 'N', kind: 'native', url: 'https://cdn.example' } as unknown as SourceAdapter);
        const url = 'https://cdn.example/01.png';

        const first = await pageImage(app, url);
        expect(first.statusCode).toBe(200);
        expect(first.headers['x-cache']).toBeUndefined();
        expect(first.rawPayload.equals(PNG)).toBe(true);

        const second = await pageImage(app, url);
        expect(second.statusCode).toBe(200);
        expect(second.headers['x-cache']).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await app.close();
    });

    it("uses the source's fetchPageImage transport instead of a raw fetch", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const fetchPageImage = vi.fn(async () => ({ mime: 'image/png', data: new Uint8Array(PNG) }));
        const app = boot({ id: 'native', label: 'N', kind: 'native', url: 'https://cdn.example', fetchPageImage } as unknown as SourceAdapter);

        const response = await pageImage(app, 'https://cdn.example/01.png');
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.equals(PNG)).toBe(true);
        expect(fetchPageImage).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
        await app.close();
    });

    it('caps concurrent outbound fetches per host', async () => {
        let active = 0;
        let maxActive = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise(resolve => setTimeout(resolve, 20));
                active--;
                return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
            })
        );
        const app = boot({ id: 'native', label: 'N', kind: 'native', url: 'https://cdn.example' } as unknown as SourceAdapter);

        const promises = Array.from({ length: 8 }, (_, i) => pageImage(app, `https://cdn.example/${i}.png`));
        const responses = await Promise.all(promises);
        expect(responses.every(response => response.statusCode === 200)).toBe(true);
        expect(maxActive).toBeLessThanOrEqual(4);
        expect(maxActive).toBeGreaterThan(0);
        await app.close();
    });
});
