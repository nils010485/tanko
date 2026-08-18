/**
 * Image proxy: serves remote covers/thumbnails through the server so the
 * dashboard can display them despite hotlink protection (Referer checks)
 * and mixed-content/CORS constraints. Small in-memory LRU cache included.
 */
import type { FastifyInstance } from 'fastify';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
    contentType: string;
    body: Buffer;
}

export function registerImageRoutes(app: FastifyInstance): void {
    const cache = new Map<string, CacheEntry>();

    const cacheGet = (url: string): CacheEntry | undefined => {
        const entry = cache.get(url);
        if (entry) {
            // refresh LRU recency
            cache.delete(url);
            cache.set(url, entry);
        }
        return entry;
    };

    const cacheSet = (url: string, entry: CacheEntry): void => {
        cache.set(url, entry);
        while (cache.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
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
            target = new URL(raw);
        } catch {
            return reply.code(400).send({ error: 'Invalid "url" parameter' });
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            return reply.code(400).send({ error: 'Only http(s) URLs are allowed' });
        }

        const cached = cacheGet(raw);
        if (cached) {
            return reply
                .header('Content-Type', cached.contentType)
                .header('Cache-Control', 'public, max-age=86400')
                .header('X-Cache', 'hit')
                .send(cached.body);
        }

        let response;
        try {
            response = await fetch(target, {
                headers: {
                    'User-Agent': USER_AGENT,
                    // many hosts reject image requests without a matching Referer
                    Referer: target.origin + '/',
                    Accept: 'image/avif,image/webp,image/*,*/*;q=0.8'
                },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                redirect: 'follow'
            });
        } catch {
            return reply.code(502).send({ error: 'Failed to fetch remote image' });
        }

        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.startsWith('image/')) {
            return reply.code(502).send({ error: `Remote host returned ${response.status}` });
        }

        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_IMAGE_BYTES) {
            return reply.code(502).send({ error: 'Remote image is too large' });
        }

        cacheSet(raw, { contentType, body });
        return reply
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=86400')
            .send(body);
    });
}
