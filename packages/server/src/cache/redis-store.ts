/**
 * Redis-backed cache store (optional, enabled via REDIS_URL).
 * Keys are prefixed with "hakuneko:" to avoid collisions on shared instances.
 */
import { Redis } from 'ioredis';
import type { CacheStore } from './cache.js';

const PREFIX = 'hakuneko:';

export class RedisCacheStore implements CacheStore {

    private client: Redis | undefined;

    constructor(private readonly url: string) {}

    async connect(): Promise<void> {
        this.client = new Redis(this.url, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            retryStrategy: times => Math.min(times * 500, 5000)
        });
        await this.client.connect();
    }

    async get<T = unknown>(key: string): Promise<T | undefined> {
        if (!this.client) {
            return undefined;
        }
        try {
            const raw = await this.client.get(PREFIX + key);
            return raw === null ? undefined : (JSON.parse(raw) as T);
        } catch {
            return undefined;
        }
    }

    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        if (!this.client) {
            return;
        }
        try {
            await this.client.set(PREFIX + key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSeconds)));
        } catch { /* cache is best-effort */ }
    }

    async delete(key: string): Promise<void> {
        if (!this.client) {
            return;
        }
        try {
            await this.client.del(PREFIX + key);
        } catch { /* ignore */ }
    }

    async close(): Promise<void> {
        if (this.client) {
            this.client.disconnect();
            this.client = undefined;
        }
    }
}
