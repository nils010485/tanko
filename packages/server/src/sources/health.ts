/**
 * Source health-check service: probes sources for reachability and persists
 * the results so the dashboard can filter sources that actually work.
 */

import type { SourceAdapter } from '@tanko/core';
import type { SourceHealthDto } from '@tanko/shared';
import type { Database } from '../db.js';
import type { EventBus } from '../ws.js';

const PROBE_CONCURRENCY = 4;
const PROBE_STAGGER_MS = 150;

interface HealthRow {
    source_id: string;
    ok: number;
    latency_ms: number | null;
    error: string | null;
    checked_at: string;
}

export class SourceHealthService {
    private readonly checking = new Set<string>();

    constructor(
        private readonly opts: {
            db: Database;
            events: EventBus;
            getAdapter: (id: string) => Promise<SourceAdapter | undefined>;
            listAdapterIds: () => Promise<string[]>;
        }
    ) {
        this._migrate();
    }

    // ------------------------------------------------------------------
    // reads
    // ------------------------------------------------------------------

    getAll(): Record<string, SourceHealthDto> {
        const rows = this.opts.db.db.prepare('SELECT * FROM source_health').all() as unknown as HealthRow[];
        const result: Record<string, SourceHealthDto> = {};
        for (const row of rows) {
            result[row.source_id] = this._toDto(row);
        }
        for (const sourceId of this.checking) {
            result[sourceId] = { sourceId, status: 'checking' };
        }
        return result;
    }

    get(sourceId: string): SourceHealthDto {
        if (this.checking.has(sourceId)) {
            return { sourceId, status: 'checking' };
        }
        const row = this.opts.db.db.prepare('SELECT * FROM source_health WHERE source_id = ?').get(sourceId) as HealthRow | undefined;
        return row ? this._toDto(row) : { sourceId, status: 'untested' };
    }

    // ------------------------------------------------------------------
    // probes
    // ------------------------------------------------------------------

    async probeOne(sourceId: string): Promise<SourceHealthDto> {
        if (this.checking.has(sourceId)) {
            return { sourceId, status: 'checking' };
        }
        const adapter = await this.opts.getAdapter(sourceId);
        if (!adapter) {
            return { sourceId, status: 'error', error: 'Unknown source' };
        }
        this.checking.add(sourceId);
        this.opts.events.publishLog({
            level: 'info',
            category: 'source',
            code: 'source.healthCheck',
            params: { label: adapter.label },
            message: `Health check: ${adapter.label}...`
        });
        try {
            const result = await adapter.checkHealth();
            const now = new Date().toISOString();
            this.opts.db.db
                .prepare(
                    `INSERT INTO source_health (source_id, ok, latency_ms, error, checked_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(source_id) DO UPDATE SET ok = excluded.ok, latency_ms = excluded.latency_ms, error = excluded.error, checked_at = excluded.checked_at`
                )
                .run(sourceId, result.ok ? 1 : 0, result.latencyMs, result.error || null, now);
            return {
                sourceId,
                status: result.ok ? 'ok' : 'error',
                latencyMs: result.latencyMs,
                error: result.error,
                checkedAt: now
            };
        } finally {
            this.checking.delete(sourceId);
        }
    }

    /** Probe many sources with limited concurrency. Returns a summary. */
    async probeMany(sourceIds: string[]): Promise<{ checked: number; ok: number; errors: number }> {
        let ok = 0;
        let errors = 0;
        let checked = 0;
        let index = 0;
        const worker = async () => {
            while (index < sourceIds.length) {
                const current = sourceIds[index++];
                try {
                    const result = await this.probeOne(current);
                    checked++;
                    if (result.status === 'ok') {
                        ok++;
                    } else {
                        errors++;
                    }
                } catch {
                    checked++;
                    errors++;
                }
                await new Promise(resolve => setTimeout(resolve, PROBE_STAGGER_MS));
            }
        };
        await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, sourceIds.length) }, () => worker()));
        return { checked, ok, errors };
    }

    async probeAll(): Promise<{ checked: number; ok: number; errors: number }> {
        // a full re-check re-surfaces previously hidden sources
        this.unhideAll();
        const ids = await this.opts.listAdapterIds();
        return this.probeMany(ids);
    }

    /** Probe only native sources (fast, done in background at startup). */
    async probeNative(): Promise<void> {
        const ids = await this.opts.listAdapterIds();
        const nativeIds: string[] = [];
        for (const id of ids) {
            const adapter = await this.opts.getAdapter(id);
            if (adapter?.kind === 'native') {
                nativeIds.push(id);
            }
        }
        await this.probeMany(nativeIds);
    }

    // ------------------------------------------------------------------
    // hide / show broken sources
    // ------------------------------------------------------------------

    /** Hide every source whose last health check failed. Returns the count. */
    hideBroken(): number {
        const result = this.opts.db.db
            .prepare(
                `INSERT INTO source_flags (source_id, hidden)
             SELECT source_id, 1 FROM source_health WHERE ok = 0
             ON CONFLICT(source_id) DO UPDATE SET hidden = 1`
            )
            .run();
        return Number(result.changes);
    }

    /** Re-surface all hidden sources (used by the full re-check). */
    unhideAll(): void {
        this.opts.db.db.prepare('DELETE FROM source_flags').run();
    }

    /** Set of currently hidden source ids. */
    getHiddenSet(): Set<string> {
        const rows = this.opts.db.db.prepare('SELECT source_id FROM source_flags WHERE hidden = 1').all() as Array<{ source_id: string }>;
        return new Set(rows.map(row => row.source_id));
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private _migrate(): void {
        this.opts.db.db.exec(`
            CREATE TABLE IF NOT EXISTS source_health (
                source_id  TEXT PRIMARY KEY,
                ok         INTEGER NOT NULL,
                latency_ms INTEGER,
                error      TEXT,
                checked_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_flags (
                source_id TEXT PRIMARY KEY,
                hidden    INTEGER NOT NULL DEFAULT 1
            );
        `);
    }

    private _toDto(row: HealthRow): SourceHealthDto {
        return {
            sourceId: row.source_id,
            status: row.ok === 1 ? 'ok' : 'error',
            latencyMs: row.latency_ms ?? undefined,
            error: row.error || undefined,
            checkedAt: row.checked_at
        };
    }
}
