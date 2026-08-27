import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HealthResult, SourceAdapter } from '@tanko/core';
import type { WsEvent } from '@tanko/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { SourceHealthService } from '../src/sources/health.js';
import { EventBus } from '../src/ws.js';

const HOUR_MS = 60 * 60 * 1000;
/** Rolling pass budget (must mirror health.ts SWEEP_QUOTA). */
const SWEEP_QUOTA = 25;

let tmpDir: string;
let database: Database;
let events: EventBus;
let published: WsEvent[];

/** Fake adapter factory: scripted results (value or thunk) + per-source call counter. */
function makeService(scripted: Record<string, HealthResult | (() => HealthResult)>) {
    const calls = new Map<string, number>();
    const adapters = new Map<string, SourceAdapter>();
    for (const [id, script] of Object.entries(scripted)) {
        adapters.set(id, {
            id,
            label: id,
            tags: [],
            kind: 'legacy',
            checkHealth: async () => {
                calls.set(id, (calls.get(id) ?? 0) + 1);
                return typeof script === 'function' ? script() : script;
            }
        } as unknown as SourceAdapter);
    }
    const service = new SourceHealthService({
        db: database,
        events,
        getAdapter: async id => adapters.get(id),
        listAdapterIds: async () => [...adapters.keys()]
    });
    return { service, calls };
}

type Row = { ok: number; failure_count: number; next_probe_at: string; checked_at: string };

function row(sourceId: string): Row {
    return database.db.prepare('SELECT * FROM source_health WHERE source_id = ?').get(sourceId) as Row;
}

/** Hours between the last check and the scheduled re-probe. */
function delayHours(sourceId: string): number {
    const current = row(sourceId);
    return (Date.parse(current.next_probe_at) - Date.parse(current.checked_at)) / HOUR_MS;
}

/** Insert a health row as-is (drives the sweep's due selection directly). */
function insertRow(sourceId: string, ok: boolean, nextProbeAt: Date): void {
    database.db
        .prepare('INSERT INTO source_health (source_id, ok, latency_ms, error, checked_at, failure_count, next_probe_at) VALUES (?, ?, 10, NULL, ?, 1, ?)')
        .run(sourceId, ok ? 1 : 0, new Date().toISOString(), nextProbeAt.toISOString());
}

/** Mark a source as backing a visible (not hidden, not paused) library entry. */
function useInLibrary(sourceId: string): void {
    database.db.prepare('INSERT INTO library (source_id, hidden, paused) VALUES (?, 0, 0)').run(sourceId);
}

/** Private selection pass (sweep() calls it with the fixed quota). */
function dueSources(service: SourceHealthService, quota: number): Promise<string[]> {
    return (service as unknown as { _dueSources: (quota: number) => Promise<string[]> })._dueSources(quota);
}

const ok = (latencyMs = 10): HealthResult => ({ ok: true, latencyMs });
const fail = (error = 'timeout 20000'): HealthResult => ({ ok: false, latencyMs: 10, error });

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-health-'));
    database = new Database(tmpDir);
    // minimal stand-in for LibraryStore's table: the sweep's priority join only
    // reads source_id / hidden / paused
    database.db.exec(
        'CREATE TABLE IF NOT EXISTS library (id INTEGER PRIMARY KEY, source_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0)'
    );
    events = new EventBus();
    published = [];
    events.publish = (event: WsEvent) => {
        published.push(event);
    };
    // create source_health / source_flags up front: each service migrates on
    // construction, but beforeEach must be able to wipe the tables first
    new SourceHealthService({ db: database, events, getAdapter: async () => undefined, listAdapterIds: async () => [] });
});

beforeEach(() => {
    database.db.exec('DELETE FROM source_health; DELETE FROM source_flags; DELETE FROM library');
    published.length = 0;
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('backoff ladder', () => {
    it('climbs 1h → 6h → 24h → 7d → 30d on repeated transient failures, then caps', async () => {
        const { service } = makeService({ s: () => fail('timeout 20000') });
        for (const expected of [1, 6, 24, 7 * 24, 30 * 24, 30 * 24]) {
            await service.probeOne('s');
            expect(Math.round(delayHours('s'))).toBe(expected);
        }
        expect(row('s').failure_count).toBe(6);
    });

    it('treats DNS/5xx failures as dead: the ladder skips two rungs', async () => {
        // raw codes AND the strings the adapters actually emit (undici wraps
        // DNS/TLS failures as "fetch failed"; the legacy adapter normalizes
        // to "domaine introuvable" / "connexion impossible")
        const cases: Array<[string, string]> = [
            ['raw-code', 'getaddrinfo ENOTFOUND example.com'],
            ['fetch-failed', 'fetch failed'],
            ['domaine', 'domaine introuvable'],
            ['connexion', 'connexion impossible'],
            ['http5xx', 'HTTP 502']
        ];
        for (const [id, error] of cases) {
            const { service } = makeService({ [id]: () => fail(error) });
            await service.probeOne(id);
            expect(Math.round(delayHours(id))).toBe(24); // rung 3, not rung 1
        }
    });

    it('caps anti-bot failures at 24h (the site is up, protection comes and goes)', async () => {
        const { service } = makeService({ s: () => fail('Page protégée par anti-bot (JavaScript requis)') });
        for (let i = 0; i < 10; i++) {
            await service.probeOne('s');
            expect(delayHours('s')).toBeLessThanOrEqual(24);
        }
        expect(Math.round(delayHours('s'))).toBe(24);
    });

    it('resets the ladder on success and schedules a weekly refresh', async () => {
        const queue = [fail(), fail(), ok()];
        const { service } = makeService({ s: () => queue.shift() ?? ok() });
        await service.probeOne('s');
        await service.probeOne('s');
        expect(row('s').failure_count).toBe(2);
        await service.probeOne('s');
        expect(row('s').failure_count).toBe(0);
        expect(row('s').ok).toBe(1);
        expect(Math.round(delayHours('s'))).toBe(7 * 24);
    });
});

describe('auto-unhide', () => {
    it('re-surfaces a hidden broken source once it answers again', async () => {
        const queue = [fail(), ok()];
        const { service } = makeService({ s: () => queue.shift() ?? ok() });
        await service.probeOne('s');
        service.hideBroken();
        expect(service.getHiddenSet().has('s')).toBe(true);
        await service.probeOne('s');
        expect(service.getHiddenSet().has('s')).toBe(false);
    });
});

describe('rolling selection', () => {
    it('picks library-backed sources first, then the oldest deadlines, capped at the quota', async () => {
        const { service } = makeService({ a: ok(), b: ok(), c: ok() });
        insertRow('a', true, new Date(Date.now() - 2 * HOUR_MS));
        insertRow('b', true, new Date(Date.now() - 30 * 60 * 1000)); // freshest, but library-backed
        insertRow('c', true, new Date(Date.now() - 1 * HOUR_MS));
        useInLibrary('b');
        expect(await dueSources(service, 2)).toEqual(['b', 'a']);
    });

    it('drops the stale row of a source whose adapter is gone', async () => {
        insertRow('ghost', true, new Date(Date.now() - HOUR_MS));
        const { service } = makeService({ real: ok() }); // registry without 'ghost'
        expect(await service.probeOne('ghost')).toMatchObject({ sourceId: 'ghost', status: 'error' });
        expect(row('ghost')).toBeUndefined();
    });

    it('fills the remaining quota with never-probed sources', async () => {
        const { service } = makeService({ a: ok(), b: ok(), c: ok() });
        const picked = await dueSources(service, 2);
        expect(picked).toHaveLength(2);
        expect(['a', 'b', 'c']).toEqual(expect.arrayContaining(picked));
    });

    it('probes at most SWEEP_QUOTA sources per pass', async () => {
        const scripts: Record<string, HealthResult> = {};
        for (let i = 0; i < 30; i++) {
            const id = `src${String(i).padStart(2, '0')}`;
            scripts[id] = ok();
            insertRow(id, true, new Date(Date.now() - HOUR_MS));
        }
        const { service, calls } = makeService(scripts);
        await service.sweep();
        expect([...calls.values()].reduce((sum, n) => sum + n, 0)).toBe(SWEEP_QUOTA);
    });
});

describe('sources.updated event', () => {
    it('fires when a pass changes a status', async () => {
        const { service } = makeService({ s: ok() });
        insertRow('s', false, new Date(Date.now() - HOUR_MS)); // was error, answers again
        await service.sweep();
        expect(published.some(event => event.type === 'sources.updated')).toBe(true);
    });

    it('stays silent when nothing changed', async () => {
        const { service } = makeService({ s: ok() });
        insertRow('s', true, new Date(Date.now() - HOUR_MS)); // was ok, still ok
        await service.sweep();
        expect(published.some(event => event.type === 'sources.updated')).toBe(false);
    });
});

describe('concurrency', () => {
    it('never double-probes a source mid-check', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const { service, calls } = makeService({
            s: async () => {
                await gate; // hold the probe open until released
                return ok();
            }
        });
        const first = service.probeOne('s');
        await new Promise(resolve => setTimeout(resolve, 0)); // let it enter checkHealth
        expect(await service.probeOne('s')).toMatchObject({ sourceId: 's', status: 'checking' });
        release();
        expect(await first).toMatchObject({ sourceId: 's', status: 'ok' });
        expect(calls.get('s')).toBe(1);
    });
});

describe('start/stop timers', () => {
    it('sweeps shortly after boot, then stops cleanly', async () => {
        vi.useFakeTimers();
        try {
            const { service, calls } = makeService({ s: ok() });
            service.start();
            await vi.advanceTimersByTimeAsync(31_000); // kickoff at 30s
            expect(calls.get('s')).toBe(1);
            service.stop();
            await vi.advanceTimersByTimeAsync(HOUR_MS);
            expect(calls.get('s')).toBe(1); // interval cleared
        } finally {
            vi.useRealTimers();
        }
    });
});
