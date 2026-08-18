/**
 * SQLite-backed cache store: a simple key/value table with expiration.
 */
import type { Database } from '../db.js';
import type { CacheStore } from './cache.js';

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
    }

    async get<T = unknown>(key: string): Promise<T | undefined> {
        const row = this.db.db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as
            { value: string; expires_at: number } | undefined;
        if (!row) {
            return undefined;
        }
        if (row.expires_at <= Date.now()) {
            await this.delete(key);
            return undefined;
        }
        try {
            return JSON.parse(row.value) as T;
        } catch {
            await this.delete(key);
            return undefined;
        }
    }

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        const expiresAt = Date.now() + ttlSeconds * 1000;
        this.db.db.prepare(
            'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
        ).run(key, JSON.stringify(value), expiresAt);
        this.purgeExpired();
    }

    async delete(key: string): Promise<void> {
        this.db.db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    }

    async close(): Promise<void> {
        // nothing to release for SQLite
    }

    private purgeExpired(): void {
        this.db.db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(Date.now());
    }
}
