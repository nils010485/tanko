/**
 * Two-tier cache store: an in-memory LRU of already-parsed values in front of
 * the SQLite store, so a large catalog blob is parsed once instead of once per
 * read.
 */
import { ByteBudgetCache } from '../util/image-cache.js';
import type { CacheStore } from './cache.js';
import type { CacheEntry, SqliteCacheStore } from './sqlite-store.js';

const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

export class TieredCacheStore implements CacheStore {
    private readonly memory = new ByteBudgetCache<CacheEntry>(MEMORY_BUDGET_BYTES, entry => entry.bytes);

    constructor(private readonly inner: SqliteCacheStore) {}

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const cached = this.memory.get(key);
        if (cached !== undefined) {
            if (cached.expiresAt > Date.now()) {
                return cached.value as T;
            }
            this.memory.delete(key);
        }
        const entry = await this.inner.getWithExpiry(key);
        if (entry === undefined) {
            return undefined;
        }
        this.memory.set(key, entry);
        return entry.value as T;
    }

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        await this.inner.set(key, value, ttlSeconds);
        this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, bytes: JSON.stringify(value).length });
    }

    async delete(key: string): Promise<void> {
        await this.inner.delete(key);
        this.memory.delete(key);
    }

    async clear(): Promise<number> {
        const removed = await this.inner.clear();
        this.memory.clear();
        return removed;
    }

    dispose(): void {
        this.inner.dispose();
    }
}
