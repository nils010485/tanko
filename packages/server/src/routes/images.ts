/**
 * Image proxy: serves remote covers/thumbnails through the server so the
 * dashboard can display them despite hotlink protection (Referer checks)
 * and mixed-content/CORS constraints. Small in-memory LRU cache included.
 */
import type { FastifyInstance } from 'fastify';
import { assertPublicHttpUrl, fetchGuarded, readBodyCapped } from '../util/net-guard.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
/** Total RAM the image cache may use. */
const MAX_CACHE_BYTES = 400 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
    contentType: string;
    body: Buffer;
}

export function registerImageRoutes(app: FastifyInstance): void {
    const cache = new Map<string, CacheEntry>();
    let cacheBytes = 0;

    const cacheGet = (url: string): CacheEntry | undefined => {
        const entry = cache.get(url);
        if (entry) {
            // refresh LRU recency
            cache.delete(url);
            cache.set(url, entry);
        }
        return entry;
    };

    // byte-budget LRU: evict oldest (Map order) until under budget; oversized entries are served but not cached
    const cacheSet = (url: string, entry: CacheEntry): void => {
        const previous = cache.get(url);
        if (previous) {
            cacheBytes -= previous.body.length;
        }
        if (entry.body.length > MAX_CACHE_BYTES) {
            cache.delete(url);
            return;
        }
        cache.set(url, entry);
        cacheBytes += entry.body.length;
        while (cacheBytes > MAX_CACHE_BYTES && cache.size > 0) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cacheBytes -= cache.get(oldest)?.body.length ?? 0;
            cache.delete(oldest);
        }
    };

    app.get<{ Querystring: { url?: string } }>('/api/image', async (request, reply) => {
        const raw = request.query.url;
        if (!raw) {
            return reply.code(400).send({ error: 'Query parameter "url" is required' });
        }

        let target: URL;
        try {
            target = await assertPublicHttpUrl(raw);
        } catch {
            return reply.code(400).send({ error: 'Invalid or blocked "url" parameter' });
        }

        const cached = cacheGet(raw);
        if (cached) {
            return reply.header('Content-Type', cached.contentType).header('Cache-Control', 'public, max-age=86400').header('X-Cache', 'hit').send(cached.body);
        }

        let response: Response;
        try {
            response = await fetchGuarded(target.href, {
                headers: {
                    'User-Agent': USER_AGENT,
                    // many hosts reject image requests without a matching Referer
                    Referer: `${target.origin}/`,
                    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
            });
        } catch {
            return reply.code(502).send({ error: 'Failed to fetch remote image' });
        }

        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.startsWith('image/')) {
            return reply.code(502).send({ error: `Remote host returned ${response.status}` });
        }

        let body: Buffer;
        try {
            body = await readBodyCapped(response, MAX_IMAGE_BYTES);
        } catch {
            return reply.code(502).send({ error: 'Remote image is too large' });
        }

        cacheSet(raw, { contentType, body });
        return reply.header('Content-Type', contentType).header('Cache-Control', 'public, max-age=86400').send(body);
    });
}
