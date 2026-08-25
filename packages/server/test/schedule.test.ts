import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LibraryEntryDto } from '@tanko/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';
import { DownloadQueue } from '../src/downloader/queue.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let queue: DownloadQueue;
const schedulers: Scheduler[] = [];

function buildScheduler(store?: unknown, failover?: unknown): Scheduler {
    const defaultStore = { listEntries: async () => [], checkForNewChapters: async () => ({ fresh: [], usableSeen: 1 }) };
    const scheduler = new Scheduler({
        db: database,
        store: (store ?? defaultStore) as never,
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
        const store = {
            listEntries: async () => [],
            resetCheckFailures: () => {},
            // several entries of the same source are failing at once -> outage
            listDownloadFailing: () => [entry],
            countRecentSourceFailures: () => 5,
            resetDownloadFailures: () => {}
        };
        await buildScheduler(store, { maybeMigrate, tryBeginProbe: () => true, endProbe: () => {} }).runNow();
        expect(maybeMigrate).not.toHaveBeenCalled();
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
