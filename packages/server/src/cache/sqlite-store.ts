/**
 * SQLite-backed cache store: a simple key/value table with expiration.
 */
import type { Database } from '../db.js';
import type { CacheStore } from './cache.js';

export interface CacheEntry {
    value: unknown;
    expiresAt: number;
    /** Serialized size in bytes, precomputed so LRU eviction never re-stringifies. */
    bytes: number;
}

const PURGE_INTERVAL_MS = 5 * 60 * 1000;

export class SqliteCacheStore implements CacheStore {
    constructor(private readonly db: Database) {
        this.db.db.exec(`
            CREATE TABLE IF NOT EXISTS cache (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
        `);
        setInterval(() => this.purgeExpired(), PURGE_INTERVAL_MS).unref();
    }

    /** Reads a row and returns it with its expiration timestamp (single parse). */
    async getWithExpiry(key: string): Promise<CacheEntry | undefined> {
        const row = this.db.db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as { value: string; expires_at: number } | undefined;
        if (!row) {
            return undefined;
        }
        if (row.expires_at <= Date.now()) {
            await this.delete(key);
            return undefined;
        }
        try {
            return { value: JSON.parse(row.value) as unknown, expiresAt: row.expires_at, bytes: row.value.length };
        } catch {
            await this.delete(key);
            return undefined;
        }
    }

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const entry = await this.getWithExpiry(key);
        return entry?.value as T | undefined;
    }

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        const expiresAt = Date.now() + ttlSeconds * 1000;
        this.db.db
            .prepare(
                'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
            )
            .run(key, JSON.stringify(value), expiresAt);
    }

    async delete(key: string): Promise<void> {
        this.db.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    }

    async clear(): Promise<number> {
        const result = this.db.db.prepare('DELETE FROM cache').run();
        return Number(result.changes);
    }

    private purgeExpired(): void {
        this.db.db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(Date.now());
    }
}
