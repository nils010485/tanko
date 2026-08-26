import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LibraryEntryDto } from '@tanko/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { LibraryStore } from '../src/library/store.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let queue: DownloadQueue;
const schedulers: Scheduler[] = [];

/** Store contract with inert defaults: each test's store (mock or real
 *  instance) is wrapped so that any method it does not provide falls back to
 * an inert default — a run must never crash because a mock lacks a method
 * the scheduler started calling (the crash would be swallowed by runNow's
 * catch and the assertions would pass vacuously). */
function buildScheduler(store?: object, failover?: unknown): Scheduler {
    const defaults: Record<string, unknown> = {
        listEntries: async () => [],
        checkForNewChapters: async () => ({ fresh: [], usableSeen: 1 }),
        listSourceOutages: () => [],
        getSourceOutage: () => undefined,
        noteSourceFailure: () => undefined,
        countEntriesWithCheckFailures: () => 0,
        closeSourceOutage: () => false,
        armOutageEscalation: () => undefined,
        listDownloadFailing: () => [],
        resetDownloadFailures: () => undefined,
        recordCheckFailure: () => 0,
        resetCheckFailures: () => undefined,
        enqueueChapters: () => undefined,
        getEntry: () => undefined,
        listStaleEntries: () => [],
        setHidden: () => undefined,
        listStalledCandidates: () => [],
        recordStalenessProbe: () => undefined
    };
    const effective = store
        ? new Proxy(store, {
              get: (target, prop) => (Reflect.has(target, prop) ? Reflect.get(target, prop) : defaults[prop as string])
          })
        : defaults;
    const scheduler = new Scheduler({
        db: database,
        store: effective as never,
        queue,
        events: new EventBus(),
        ...(failover ? { failover } : {})
    });
    schedulers.push(scheduler);
    return scheduler;
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-schedule-'));
    database = new Database(tmpDir);
    queue = new DownloadQueue({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        events: new EventBus(),
        settings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

afterAll(async () => {
    for (const scheduler of schedulers) {
        scheduler.stop();
    }
    queue.stop();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduler last-run persistence', () => {
    it('keeps a non-empty last-run summary across restarts', async () => {
        const entry = { id: 1, sourceId: 'src', sourceLabel: 'Source', title: 'Series' } as unknown as LibraryEntryDto;
        const store = {
            listEntries: async () => [entry],
            checkForNewChapters: async () => ({ fresh: [{ chapter_id: 'c1', title: 'Ch. 1' }], usableSeen: 3 }),
            getEntry: () => entry,
            resetCheckFailures: () => {},
            recordCheckFailure: () => 0,
            enqueueChapters: () => {}
        };
        const first = buildScheduler(store);
        const result = await first.runNow();
        expect(result).toEqual({ checked: 1, newChapters: 1 });

        // a restart wipes the in-memory fields; the fresh instance restores them
        const restored = buildScheduler().status();
        expect(restored.lastRunAt).toBe(first.status().lastRunAt);
        expect(restored.seriesChecked).toBe(1);
        expect(restored.newChaptersFound).toBe(1);
    });

    it('survives a corrupted last-run payload', () => {
        database.kvSet('schedule.lastrun', 'not json');
        expect(buildScheduler().status().lastRunAt).toBeUndefined();
    });
});

describe('scheduler failover dedup', () => {
    it('probes an entry only once per run even when both loops target it', async () => {
        const maybeMigrate = vi.fn().mockResolvedValue('none');
        const entry = { id: 7, sourceId: 'src', title: 'Series', sourceLabel: 'Source' };
        const store = {
            // the check fails -> _handleCheckFailure arms the failover
            listEntries: async () => [entry],
            checkForNewChapters: async () => {
                throw new Error('boom');
            },
            recordCheckFailure: () => 3,
            resetCheckFailures: () => {},
            noteSourceFailure: () => undefined,
            // the same entry also sits in the download-failing list
            listDownloadFailing: () => [entry],
            resetDownloadFailures: () => {}
        };
        await buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        expect(maybeMigrate).toHaveBeenCalledTimes(1);
        expect(maybeMigrate).toHaveBeenCalledWith({ id: 7, sourceId: 'src', title: 'Series' });
    });

    it('suspends the download-failure failover during a source-wide outage', async () => {
        const maybeMigrate = vi.fn().mockResolvedValue('none');
        const entry = { id: 9, sourceId: 'src', title: 'Outage Series', sourceLabel: 'Source' };
        // fresh lastSeenAt: an old one would take the silence-close branch
        // instead of the suspension this test exercises
        const suspended = { sourceId: 'src', startedAt: '2020-01-01T00:00:00.000Z', lastSeenAt: new Date().toISOString(), failures: 5, escalatedAt: null };
        const store = {
            // several entries of the same source are failing at once -> outage
            listSourceOutages: () => [suspended],
            armOutageEscalation: () => suspended,
            getSourceOutage: () => suspended,
            listDownloadFailing: () => [entry]
        };
        const scheduler = buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} });
        await scheduler.runNow();
        // the run must have reached the backstop loop (not crashed silently)
        expect(scheduler.status().lastRunResult).toContain('checked');
        expect(maybeMigrate).not.toHaveBeenCalled();
    });

    it('re-allows the download-failure failover once the outage is escalated', async () => {
        const maybeMigrate = vi.fn().mockResolvedValue('none');
        const entry = { id: 9, sourceId: 'src', title: 'Outage Series', sourceLabel: 'Source' };
        const escalated = {
            sourceId: 'src',
            startedAt: '2020-01-01T00:00:00.000Z',
            lastSeenAt: new Date().toISOString(),
            failures: 9,
            escalatedAt: '2020-01-01T03:00:00.000Z'
        };
        const store = {
            listSourceOutages: () => [escalated],
            armOutageEscalation: () => escalated,
            getSourceOutage: () => escalated,
            listDownloadFailing: () => [entry]
        };
        const scheduler = buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} });
        await scheduler.runNow();
        expect(scheduler.status().lastRunResult).toContain('checked');
        expect(maybeMigrate).toHaveBeenCalledTimes(1);
    });

    it('does not close an outage by silence while the source still has retryable jobs', async () => {
        // real store + real queue: a failed job with retries left pins the
        // outage open even when its last_seen_at is long stale (deep backoff)
        const realStore = new LibraryStore({
            db: database,
            registry: { get: async () => undefined, list: async () => [] } as never,
            queueSettings: {
                dataDirectory: path.join(tmpDir, 'downloads'),
                directoryLayout: 'source',
                chapterFormat: 'img',
                parallelSources: 1,
                concurrencyPerSource: 1,
                throttleMs: 0
            }
        });
        realStore.noteSourceFailure('pinned', true);
        const jobId = Number(
            database.db
                .prepare(
                    `INSERT INTO download_jobs
                    (entry_id, source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, auto_retries, created_at, updated_at)
                    VALUES (NULL, 'pinned', 'm', 'c', 'M', 'C', 'failed', 100, 1, 0, 2, ?, ?)`
                )
                .run(new Date().toISOString(), new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()).lastInsertRowid
        );
        // stale last_seen_at: older than OUTAGE_SILENCE_MS
        database.db
            .prepare("UPDATE source_outages SET last_seen_at = ? WHERE source_id = 'pinned'")
            .run(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());

        await buildScheduler(realStore as never).runNow();
        expect(realStore.getSourceOutage('pinned')).toBeDefined(); // pinned by the retryable job

        // ladder exhausted: nothing left to retry -> the silence-close fires
        database.db.prepare('UPDATE download_jobs SET auto_retries = 10 WHERE id = ?').run(jobId);
        await buildScheduler(realStore as never).runNow();
        expect(realStore.getSourceOutage('pinned')).toBeUndefined();
    });
});

describe('scheduler auto-unfollow of stale series', () => {
    it('hides stale entries when enabled, keeps them when disabled', async () => {
        const stale = { id: 1, title: 'Old Series', lastChapterAt: '2020-01-01T00:00:00.000Z' };
        const hidden: number[] = [];
        const store = {
            listEntries: async () => [{ id: 1, sourceId: 'src', title: 'Old Series', sourceLabel: 'Source', downloadedCount: 0, autoDownload: false }],
            checkForNewChapters: async () => ({ fresh: [], usableSeen: 1 }),
            resetCheckFailures: () => {},
            listSourceOutages: () => [],
            recordCheckFailure: () => 1,
            getEntry: () => undefined,
            listDownloadFailing: () => [],
            listStaleEntries: () => [stale],
            setHidden: (id: number, value: boolean) => {
                if (value) {
                    hidden.push(id);
                }
            }
        };
        const disabled = buildScheduler(store);

        await disabled.runNow();
        expect(hidden).toEqual([]);

        const enabled = buildScheduler(store);
        enabled.updateSettings({ autoUnfollow: true });
        await enabled.runNow();
        expect(hidden).toEqual([1]);
        // restore the shared persisted setting so later suites start clean
        enabled.updateSettings({ autoUnfollow: false });
    });
});
describe('scheduler check-failure wave', () => {
    it('opens the outage on a wave of thrown errors, suspending migration', async () => {
        const maybeMigrate = vi.fn().mockResolvedValue('none');
        const entry = { id: 11, sourceId: 'src', title: 'Wave Series', sourceLabel: 'Source' };
        const suspended = { sourceId: 'src', startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), failures: 1, escalatedAt: null };
        const store = {
            listEntries: async () => [entry],
            checkForNewChapters: async () => {
                throw new Error('fetch failed');
            },
            recordCheckFailure: () => 3,
            // three entries of the source are failing their checks -> wave
            countEntriesWithCheckFailures: () => 3,
            noteSourceFailure: (_sourceId: string, open: boolean) => (open ? suspended : undefined)
        };
        const scheduler = buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} });
        await scheduler.runNow();
        expect(scheduler.status().lastRunResult).toContain('checked');
        expect(maybeMigrate).not.toHaveBeenCalled(); // suspended, not probed
    });

    it('still migrates a takedown wave (listing OK, zero usable chapters)', async () => {
        const maybeMigrate = vi.fn().mockResolvedValue('none');
        const entry = { id: 12, sourceId: 'src', title: 'Takedown Series', sourceLabel: 'Source' };
        const store = {
            listEntries: async () => [entry],
            checkForNewChapters: async () => {
                throw new Error('la source ne référence plus aucun chapitre dans les langues préférées');
            },
            recordCheckFailure: () => 3,
            countEntriesWithCheckFailures: () => 3,
            noteSourceFailure: (_sourceId: string, open: boolean) => (open ? { escalatedAt: null } : undefined)
        };
        const scheduler = buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} });
        await scheduler.runNow();
        expect(scheduler.status().lastRunResult).toContain('checked');
        expect(maybeMigrate).toHaveBeenCalledTimes(1); // content removal -> probe, no suspension
    });
});

describe('scheduler stalled-source detection pass', () => {
    it('probes stalled candidates and records the back-off outcome', async () => {
        const suggestIfStalled = vi.fn().mockResolvedValueOnce('miss').mockResolvedValueOnce('suggested');
        const recordStalenessProbe = vi.fn();
        const found = { id: 31, sourceId: 'src', title: 'Found', sourceLabel: 'Source' } as unknown as LibraryEntryDto;
        const store = {
            listEntries: async () => [],
            listStalledCandidates: () => [
                { id: 21, sourceId: 'src', title: 'Hiatus Series', chapterCount: 40 },
                { id: 31, sourceId: 'src', title: 'Found', chapterCount: 90 }
            ],
            recordStalenessProbe,
            getEntry: () => found
        };
        await buildScheduler(store, { suggestIfStalled, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        // the detection pass runs in the background after the run itself
        await vi.waitFor(() => expect(suggestIfStalled).toHaveBeenCalledTimes(2), { timeout: 4000 });
        expect(recordStalenessProbe).toHaveBeenCalledWith(21, false);
        expect(recordStalenessProbe).toHaveBeenCalledWith(31, true);
        expect(suggestIfStalled).toHaveBeenCalledWith({ id: 31, sourceId: 'src', title: 'Found' }, 90);
    });

    it("moves no back-off and consumes no budget while probes are 'skipped'", async () => {
        const suggestIfStalled = vi.fn().mockResolvedValue('skipped');
        const recordStalenessProbe = vi.fn();
        const store = {
            listEntries: async () => [],
            listStalledCandidates: () =>
                Array.from({ length: 12 }, (_, index) => ({ id: 40 + index, sourceId: 'src', title: `Stalled ${index}`, chapterCount: 10 })),
            recordStalenessProbe
        };
        await buildScheduler(store, { suggestIfStalled, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        // 12 candidates — more than DETECTION_PROBES — yet 'skipped' costs nothing
        await vi.waitFor(() => expect(suggestIfStalled).toHaveBeenCalledTimes(12), { timeout: 4000 });
        expect(recordStalenessProbe).not.toHaveBeenCalled();
    });

    it('backs off a probe that errored instead of guessing a hiatus', async () => {
        const suggestIfStalled = vi.fn().mockRejectedValue(new Error('crawl failed'));
        const recordStalenessProbe = vi.fn();
        const store = {
            listEntries: async () => [],
            listStalledCandidates: () => [{ id: 55, sourceId: 'src', title: 'Flaky', chapterCount: 30 }],
            recordStalenessProbe
        };
        await buildScheduler(store, { suggestIfStalled, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        await vi.waitFor(() => expect(recordStalenessProbe).toHaveBeenCalledWith(55, false), { timeout: 4000 });
    });

    it('does not let a disabled starved pass burn the shared probe budget', async () => {
        // 12 entries are eligible for the starved regime, but its toggle is
        // off: every call is 'skipped' and must cost nothing — the stalled
        // candidates still get their probes (regression: the shared budget
        // used to be drained by probes that never crawled)
        const suggestIfIncomplete = vi.fn().mockResolvedValue('skipped');
        const suggestIfStalled = vi.fn().mockResolvedValue('miss');
        const recordStalenessProbe = vi.fn();
        const store = {
            listEntries: async () =>
                Array.from({ length: 12 }, (_, index) => ({
                    id: 60 + index,
                    sourceId: 'src',
                    title: `Starved ${index}`,
                    chapterCount: 5,
                    migrationSuggestion: undefined,
                    hidden: false
                })),
            listStalledCandidates: () => [{ id: 80, sourceId: 'src', title: 'Stalled', chapterCount: 40 }],
            recordStalenessProbe
        };
        await buildScheduler(store, { suggestIfIncomplete, suggestIfStalled, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        await vi.waitFor(() => expect(suggestIfStalled).toHaveBeenCalledTimes(1), { timeout: 4000 });
        expect(suggestIfIncomplete).toHaveBeenCalledTimes(12);
        expect(recordStalenessProbe).toHaveBeenCalledWith(80, false);
    });
});
