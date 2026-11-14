/**
 * Image proxy: serves remote covers/thumbnails through the server so the
 * dashboard can display them despite hotlink protection (Referer checks)
 * and mixed-content/CORS constraints. Small in-memory LRU cache included.
 */
import type { SourceRegistry } from '@tanko/core';
import type { FastifyInstance } from 'fastify';
import { ByteBudgetCache } from '../util/image-cache.js';
import { assertPublicHttpUrl, fetchGuarded, readBodyCapped } from '../util/net-guard.js';

const FETCH_TIMEOUT_MS = 10_000;
/** Total RAM the image cache may use. */
const MAX_CACHE_BYTES = 400 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const USER_AGENTS = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Tanko (+https://github.com/nils010485/tanko)'
];

interface CacheEntry {
    contentType: string;
    body: Buffer;
}

type Attempt = { image: CacheEntry } | { error: string; retryable: boolean };

async function fetchImage(target: URL, referer: string, userAgent: string): Promise<Attempt> {
    let response: Response;
    try {
        response = await fetchGuarded(target.href, {
            headers: {
                'User-Agent': userAgent,
                // many hosts reject image requests without a matching Referer
                Referer: referer,
                Accept: 'image/avif,image/webp,image/*,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
    } catch {
        return { error: 'Failed to fetch remote image', retryable: false };
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (!response.ok || !contentType.startsWith('image')) {
        await response.body?.cancel().catch(() => undefined);
        return { error: `Remote host returned ${response.status}`, retryable: true };
    }

    try {
        return { image: { contentType, body: await readBodyCapped(response, MAX_IMAGE_BYTES) } };
    } catch {
        return { error: 'Remote image is too large', retryable: false };
    }
}

async function fetchFirstImage(target: URL, referer: string): Promise<Attempt> {
    let attempt = await fetchImage(target, referer, USER_AGENTS[0]);
    for (const userAgent of USER_AGENTS.slice(1)) {
        if ('image' in attempt || !attempt.retryable) {
            break;
        }
        attempt = await fetchImage(target, referer, userAgent);
    }
    return attempt;
}

async function sourceSite(sourceRegistry: SourceRegistry, sourceId: string | undefined): Promise<string | undefined> {
    if (!sourceId) {
        return undefined;
    }
    try {
        const url = (await sourceRegistry.get(sourceId))?.url;
        return url ? `${url.replace(/\/+$/, '')}/` : undefined;
    } catch {
        return undefined; // unknown/unloadable source: bare proxy behaviour
    }
}

export function registerImageRoutes(app: FastifyInstance, sourceRegistry: SourceRegistry): void {
    const cache = new ByteBudgetCache<CacheEntry>(MAX_CACHE_BYTES, entry => entry.body.length);

    app.get<{ Querystring: { url?: string; sourceId?: string } }>('/api/image', async (request, reply) => {
        const raw = request.query.url;
        if (!raw) {
            return reply.code(400).send({ error: 'Query parameter "url" is required' });
        }

        const site = await sourceSite(sourceRegistry, request.query.sourceId);
        let target: URL;
        try {
            target = await assertPublicHttpUrl(site ? new URL(raw, site).href : raw);
        } catch {
            return reply.code(400).send({ error: 'Invalid or blocked "url" parameter' });
        }

        const cached = cache.get(target.href);
        if (cached) {
            return reply.header('Content-Type', cached.contentType).header('Cache-Control', 'public, max-age=86400').header('X-Cache', 'hit').send(cached.body);
        }

        const referer = site ?? `${target.origin}/`;
        const attempt = await fetchFirstImage(target, referer);
        if ('error' in attempt) {
            return reply.code(502).send({ error: attempt.error });
        }

        const image = attempt.image;
        cache.set(target.href, image);
        return reply.header('Content-Type', image.contentType).header('Cache-Control', 'public, max-age=86400').send(image.body);
    });
}
