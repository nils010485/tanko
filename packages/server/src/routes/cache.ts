/**
 * Internal cache maintenance: clears the SQLite source-data cache (catalogs,
 * chapter lists, search results) from the dashboard maintenance tools.
 */
import type { FastifyInstance } from 'fastify';
import type { CacheStore } from '../cache/cache.js';

export function registerCacheRoutes(app: FastifyInstance, cache: CacheStore): void {
    app.post('/api/maintenance/cache/clear', async () => ({ cleared: await cache.clear() }));
}
