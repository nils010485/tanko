/**
 * Cache abstraction: SQLite by default (self-contained), Redis when
 * REDIS_URL is set. Values are JSON-serializable, entries expire (TTL).
 */
import type { Database } from '../db.js';
import { SqliteCacheStore } from './sqlite-store.js';
import { RedisCacheStore } from './redis-store.js';

export interface CacheStore {
    /** Returns the cached value, or undefined when missing/expired. */
    get<T = unknown>(key: string): Promise<T | undefined>;
    /** Stores a value with a time-to-live in seconds. */
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
    /** Release any underlying resources (connections). */
    close(): Promise<void>;
}

export async function createCacheStore(db: Database, redisUrl?: string): Promise<CacheStore> {
    if (redisUrl && redisUrl.trim()) {
        const store = new RedisCacheStore(redisUrl.trim());
        await store.connect();
        console.log(`[cache] using Redis (${redisUrl.replace(/:[^:@/]+@/, ':***@')})`);
        return store;
    }
    console.log('[cache] using SQLite');
    return new SqliteCacheStore(db);
}
