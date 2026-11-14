import type { SourceRegistry } from '@tanko/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerImageRoutes } from '../src/routes/images.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

vi.mock('node:dns/promises', () => ({ default: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }));

function boot(sites: Record<string, string> = {}): FastifyInstance {
    const app = Fastify();
    const registry = { get: async (id: string) => (sites[id] ? { url: sites[id] } : undefined) } as unknown as SourceRegistry;
    registerImageRoutes(app, registry);
    return app;
}

const image = (app: FastifyInstance, url: string, sourceId?: string) =>
    app.inject({ method: 'GET', url: `/api/image?url=${encodeURIComponent(url)}${sourceId ? `&sourceId=${sourceId}` : ''}` });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('image proxy', () => {
    it('retries with the identified UA when the host answers a challenge page', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const userAgent = new Headers(init?.headers).get('user-agent') ?? '';
            return userAgent.startsWith('Mozilla/')
                ? new Response('<html>challenge</html>', { headers: { 'content-type': 'text/html' } })
                : new Response(PNG, { headers: { 'content-type': 'image/png' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const app = boot();
        const response = await image(app, 'https://uploads.example/covers/1.jpg');
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/png');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await app.close();
    });

    it('reports a host that never serves an image', async () => {
        const fetchMock = vi.fn(async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }));
        vi.stubGlobal('fetch', fetchMock);
        const app = boot();
        const response = await image(app, 'https://cdn.example/missing.png');
        expect(response.statusCode).toBe(502);
        expect(response.json()).toEqual({ error: 'Remote host returned 404' });
        await app.close();
    });

    it('serves a cached copy on the second request', async () => {
        const fetchMock = vi.fn(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('fetch', fetchMock);
        const app = boot();
        await image(app, 'https://cdn.example/cover.png');
        const cached = await image(app, 'https://cdn.example/cover.png');
        expect(cached.statusCode).toBe(200);
        expect(cached.headers['x-cache']).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await app.close();
    });

    it('sends the source site as Referer for a hotlink-protected CDN', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
            const referer = new Headers(init?.headers).get('referer');
            return referer === 'https://source.example/'
                ? new Response(PNG, { headers: { 'content-type': 'image/webp' } })
                : new Response('<html>hotlink</html>', { status: 403, headers: { 'content-type': 'text/html' } });
        });
        vi.stubGlobal('fetch', fetchMock);
        const app = boot({ kunmanga: 'https://source.example' });
        const response = await image(app, 'https://cdn.other.example/cover.webp', 'kunmanga');
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/webp');
        await app.close();
    });

    it('accepts a CDN that labels its images with a bare "image" type', async () => {
        const fetchMock = vi.fn(async () => new Response(PNG, { headers: { 'content-type': 'image' } }));
        vi.stubGlobal('fetch', fetchMock);
        const app = boot();
        const response = await image(app, 'https://cdn.example/cover');
        expect(response.statusCode).toBe(200);
        expect(response.rawPayload.equals(PNG)).toBe(true);
        await app.close();
    });

    it('resolves a site-relative cover against the source site', async () => {
        const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(PNG, { headers: { 'content-type': 'image/webp' } }));
        vi.stubGlobal('fetch', fetchMock);
        const app = boot({ madara: 'https://source.example' });
        const response = await image(app, '/wp-content/uploads/cover.webp', 'madara');
        expect(response.statusCode).toBe(200);
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://source.example/wp-content/uploads/cover.webp');
        await app.close();
    });
});
