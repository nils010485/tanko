/**
 * Cache abstraction (SQLite-backed, see sqlite-store.ts). Values are
 * JSON-serializable, entries expire (TTL).
 */
export interface CacheStore {
    /** Returns the cached value, or undefined when missing/expired. */
    get<T = unknown>(key: string): Promise<T | undefined>;
    /** Stores a value with a time-to-live in seconds. */
    set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
}
