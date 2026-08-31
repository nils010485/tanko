/**
 * Source health-check service: probes sources for reachability, persists the
 * results so the dashboard can filter sources that actually work, and keeps
 * re-checking failing sources in the background on a rolling backoff ladder.
 */

import type { HealthResult, SourceAdapter } from '@tanko/core';
import type { SourceHealthDto } from '@tanko/shared';
import type { Database } from '../db.js';
import type { EventBus } from '../ws.js';

const PROBE_CONCURRENCY = 4;
const PROBE_STAGGER_MS = 150;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Backoff ladder between re-probes of a failing source: a fresh outage gets
 *  watched closely, a long-dead one ends at one probe per month. */
const RETRY_LADDER_MS = [1 * HOUR_MS, 6 * HOUR_MS, 1 * DAY_MS, 7 * DAY_MS, 30 * DAY_MS];
/** A healthy source is re-checked at this leisurely pace only: day-to-day use
 *  (search, downloads) refreshes its state anyway — this catches slow deaths. */
const OK_REFRESH_MS = 7 * DAY_MS;
/** Rolling re-check cadence: each pass probes the sources whose backoff
 *  expired (plus a few never-probed ones) — a bounded trickle instead of a
 *  1300-source sweep. */
const SWEEP_MS = 15 * 60 * 1000;
const SWEEP_QUOTA = 25;
/** First pass shortly after boot: lets the engine finish warming up. */
const SWEEP_KICKOFF_MS = 30_000;

/** How dead a failure makes the source look — drives the ladder speed. */
type HealthErrorClass = 'dead' | 'antibot' | 'transient';

function classifyHealthError(error: string | undefined): HealthErrorClass {
    const text = (error || '').toLowerCase();
    if (text.includes('anti-bot') || text.includes('javascript requis')) {
        // Cloudflare & co: the site is up, the protection comes and goes
        return 'antibot';
    }
    if (/(enotfound|eai_again|econnrefused|getaddrinfo|fetch failed|domaine introuvable|connexion impossible|http 5)/.test(text)) {
        // raw codes + the strings the adapters actually emit (undici wraps
        // DNS/TLS failures as "fetch failed"; the legacy adapter normalizes
        // to "domaine introuvable" / "connexion impossible")
        return 'dead';
    }
    return 'transient';
}

/** Delay before re-probing after the n-th consecutive failure (1-based). */
function retryDelayMs(failures: number, errorClass: HealthErrorClass): number {
    let index = Math.min(failures, RETRY_LADDER_MS.length) - 1;
    if (errorClass === 'dead') {
        // DNS gone / 5xx wall: dead domains almost never come back — skip rungs
        index = Math.min(index + 2, RETRY_LADDER_MS.length - 1);
    }
    const cap = errorClass === 'antibot' ? 1 * DAY_MS : RETRY_LADDER_MS[RETRY_LADDER_MS.length - 1];
    return Math.min(RETRY_LADDER_MS[index], cap);
}

/** Fisher-Yates shuffle (in place) — used for the random jitter. */
function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

interface HealthRow {
    source_id: string;
    ok: number;
    latency_ms: number | null;
    error: string | null;
    checked_at: string;
    failure_count: number;
    next_probe_at: string | null;
}

export class SourceHealthService {
    private readonly checking = new Set<string>();
    private sweeping = false;
    private sweepTimer: ReturnType<typeof setInterval> | undefined;
    private sweepKickoff: ReturnType<typeof setTimeout> | undefined;

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

    /** `quiet` skips the per-probe Activity log — used by the rolling sweep. */
    async probeOne(sourceId: string, opts?: { quiet?: boolean }): Promise<SourceHealthDto> {
        if (this.checking.has(sourceId)) {
            return { sourceId, status: 'checking' };
        }
        const adapter = await this.opts.getAdapter(sourceId);
        if (!adapter) {
            // adapter gone (upstream connector removed): drop the stale row —
            // its expired next_probe_at would eat sweep quota forever
            this.opts.db.db.prepare('DELETE FROM source_health WHERE source_id = ?').run(sourceId);
            return { sourceId, status: 'error', error: 'Unknown source' };
        }
        this.checking.add(sourceId);
        if (!opts?.quiet) {
            this.opts.events.publishLog({
                level: 'info',
                category: 'source',
                code: 'source.healthCheck',
                params: { label: adapter.label },
                message: `Health check: ${adapter.label}...`
            });
        }
        try {
            const result = await adapter.checkHealth();
            const checkedAt = this._recordResult(sourceId, result);
            return {
                sourceId,
                status: result.ok ? 'ok' : 'error',
                latencyMs: result.latencyMs,
                error: result.error,
                checkedAt
            };
        } finally {
            this.checking.delete(sourceId);
        }
    }

    /** Probe many sources with limited concurrency. Returns a summary.
     *  Publishes sources.updated when any status changed (sweeps, manual
     *  re-checks and single-source probes all land here). */
    async probeMany(sourceIds: string[], opts?: { quiet?: boolean }): Promise<{ checked: number; ok: number; errors: number }> {
        let ok = 0;
        let errors = 0;
        let checked = 0;
        let changed = false;
        let index = 0;
        const worker = async () => {
            while (index < sourceIds.length) {
                const current = sourceIds[index++];
                try {
                    const before = this.get(current).status;
                    const result = await this.probeOne(current, opts);
                    if (result.status === 'checking') {
                        continue; // already probed elsewhere — not a real outcome
                    }
                    if (before !== 'checking' && result.status !== before) {
                        changed = true;
                    }
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
        if (changed) {
            this.opts.events.publish({ type: 'sources.updated' });
        }
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
    // rolling re-check
    // ------------------------------------------------------------------

    /** Start the background rolling re-check (stop() on shutdown). */
    start(): void {
        if (this.sweepTimer) {
            return;
        }
        this.sweepKickoff = setTimeout(() => void this.sweep(), SWEEP_KICKOFF_MS);
        this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_MS);
    }

    stop(): void {
        if (this.sweepKickoff) {
            clearTimeout(this.sweepKickoff);
        }
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
        }
        this.sweepKickoff = this.sweepTimer = undefined;
    }

    /** One rolling pass: probe the due sources (backoff expired), topped up
     *  with never-probed ones. Sources mid-probe elsewhere are skipped by
     *  probeOne, so manual re-checks and sweeps never double-hit a site. */
    async sweep(): Promise<void> {
        if (this.sweeping) {
            return; // previous pass still running (dead sources can take ~30s each)
        }
        this.sweeping = true;
        try {
            const targets = await this._dueSources(SWEEP_QUOTA);
            if (targets.length === 0) {
                return;
            }
            // quiet: a rolling pass must not flood the Activity feed with one
            // log line per probe — only status changes leave a trace
            // (probeMany publishes sources.updated when a status changed)
            const summary = await this.probeMany(targets, { quiet: true });
            console.log(`[health] sweep: ${summary.ok}/${summary.checked} ok (${summary.errors} errors)`);
        } catch (error) {
            console.warn('[health] sweep failed:', (error as Error).message);
        } finally {
            this.sweeping = false;
        }
    }

    /** Sources to probe this pass: due ones first — those backing a visible
     *  library entry ahead of the pack, oldest deadline first — then a random
     *  slice of the never-probed ones (jitter avoids hammering the catalog in
     *  the same order every pass). NB: reads the `library` table, created by
     *  LibraryStore before this service in index.ts (tests create it too). */
    private async _dueSources(quota: number): Promise<string[]> {
        const now = new Date().toISOString();
        const due = (
            this.opts.db.db
                .prepare(
                    `SELECT s.source_id
                     FROM source_health s
                     WHERE s.next_probe_at IS NULL OR s.next_probe_at <= ?
                     ORDER BY EXISTS (SELECT 1 FROM library l WHERE l.source_id = s.source_id AND l.hidden = 0 AND l.paused = 0) DESC,
                              COALESCE(s.next_probe_at, '1970-01-01') ASC
                     LIMIT ?`
                )
                .all(now, quota) as Array<{ source_id: string }>
        ).map(row => row.source_id);
        if (due.length >= quota) {
            return due;
        }
        const probed = new Set(
            (this.opts.db.db.prepare('SELECT source_id FROM source_health').all() as Array<{ source_id: string }>).map(row => row.source_id)
        );
        const untested = shuffle((await this.opts.listAdapterIds()).filter(id => !probed.has(id)));
        return [...due, ...untested.slice(0, quota - due.length)];
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
                source_id      TEXT PRIMARY KEY,
                ok             INTEGER NOT NULL,
                latency_ms     INTEGER,
                error          TEXT,
                checked_at     TEXT NOT NULL,
                failure_count  INTEGER NOT NULL DEFAULT 0,
                next_probe_at  TEXT
            );
            CREATE TABLE IF NOT EXISTS source_flags (
                source_id TEXT PRIMARY KEY,
                hidden    INTEGER NOT NULL DEFAULT 1
            );
        `);
        // older installs: add the backoff columns, keep the last results
        const columns = this.opts.db.db.prepare('PRAGMA table_info(source_health)').all() as Array<{ name: string }>;
        this._addColumn('source_health', columns, 'failure_count', 'failure_count INTEGER NOT NULL DEFAULT 0');
        this._addColumn('source_health', columns, 'next_probe_at', 'next_probe_at TEXT');
    }

    /** Single write path for probe outcomes: last result + backoff bookkeeping
     *  (returns the checked-at timestamp). A success clears the failure count,
     *  un-hides the source and schedules a leisurely re-check; a failure climbs
     *  the ladder — dead sources climb faster, anti-bot ones are capped at a day. */
    private _recordResult(sourceId: string, result: HealthResult): string {
        const failures = result.ok ? 0 : this._nextFailureCount(sourceId);
        const nextInMs = result.ok ? OK_REFRESH_MS : retryDelayMs(failures, classifyHealthError(result.error));
        // one clock read for both timestamps: next - checked must be exactly
        // the ladder delay (no millisecond drift between the two dates)
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        this.opts.db.db
            .prepare(
                `INSERT INTO source_health (source_id, ok, latency_ms, error, checked_at, failure_count, next_probe_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(source_id) DO UPDATE SET ok = excluded.ok, latency_ms = excluded.latency_ms,
                     error = excluded.error, checked_at = excluded.checked_at,
                     failure_count = excluded.failure_count, next_probe_at = excluded.next_probe_at`
            )
            .run(sourceId, result.ok ? 1 : 0, result.latencyMs, result.error || null, now, failures, new Date(nowMs + nextInMs).toISOString());
        if (result.ok) {
            // a hidden (broken) source that answers again re-surfaces on its own
            this.opts.db.db.prepare('DELETE FROM source_flags WHERE source_id = ?').run(sourceId);
        }
        return now;
    }

    /** Consecutive failure count after this one (1 for a first-time failure). */
    private _nextFailureCount(sourceId: string): number {
        const row = this.opts.db.db.prepare('SELECT failure_count AS n FROM source_health WHERE source_id = ?').get(sourceId) as { n: number } | undefined;
        return (row?.n ?? 0) + 1;
    }

    /** ALTER TABLE helper: adds `ddl` (must reference `name`) to `table` when the column is missing. */
    private _addColumn(table: string, columns: Array<{ name: string }>, name: string, ddl: string): void {
        if (!columns.some(column => column.name === name)) {
            this.opts.db.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        }
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
