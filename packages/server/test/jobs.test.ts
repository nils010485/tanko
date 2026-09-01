import type { LibraryEntryDto } from '@tanko/shared';
import { describe, expect, it, vi } from 'vitest';
import { JobRunner } from '../src/activity/jobs.js';
import { EventBus } from '../src/ws.js';

function entry(id: number): LibraryEntryDto {
    return {
        id,
        sourceId: 's',
        sourceLabel: 'Source',
        mangaId: `m${id}`,
        title: `Series ${id}`,
        autoDownload: true,
        chapterCount: 3,
        downloadedCount: 3,
        newCount: 0,
        addedAt: new Date().toISOString()
    };
}

/** Poll until the predicate holds (bounded), so tests follow the async loop. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('timeout waiting for the job state');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

/** Capture the structured log events a runner emits through the bus. */
function captureLogs(bus: EventBus) {
    const logs: Array<{ level: string; code?: string; entryId?: number }> = [];
    bus.setLogSink(event => {
        logs.push({ level: event.level, code: event.code, entryId: event.entryId });
        return undefined;
    });
    return logs;
}

describe('JobRunner', () => {
    it('reports progress, emits structured logs and finishes', async () => {
        const bus = new EventBus();
        const logs = captureLogs(bus);
        const runner = new JobRunner();
        const notifyFinished = vi.fn();
        const result = runner.runBulk(bus, {
            label: 'Test scan',
            recapHits: 'hit(s)',
            category: 'scan',
            prefix: 'scan.test',
            entries: [entry(1), entry(2)],
            notifyFinished,
            action: async item => ({ outcome: 'suggested', detail: 'ok', hit: item.id === 1 })
        });
        expect(result).toEqual({ started: true, count: 2 });
        await until(() => runner.status().running.length === 0 && runner.status().history.length > 0);
        const last = runner.status().history[0];
        expect(last).toMatchObject({ done: 2, total: 2, hits: 1, cancelled: false, running: false });
        expect(logs.map(log => log.code)).toEqual(['scan.test.started', 'scan.test.suggested', 'scan.test.suggested', 'scan.test.finished']);
        expect(logs[1]?.entryId).toBe(1);
        expect(notifyFinished).toHaveBeenCalledWith({ done: 2, total: 2, hits: 1, cancelled: false });
    });

    it('refuses a second concurrent run (single-run guard)', async () => {
        const bus = new EventBus();
        const runner = new JobRunner();
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const first = runner.runBulk(bus, {
            label: 'Gated',
            recapHits: 'x',
            category: 'scan',
            prefix: 'scan.gated',
            entries: [entry(1)],
            action: async () => {
                await gate;
                return { outcome: 'none', detail: 'ok' };
            }
        });
        expect(first).toEqual({ started: true, count: 1 });
        expect(
            runner.runBulk(bus, {
                label: 'Other',
                recapHits: 'x',
                category: 'scan',
                prefix: 'scan.other',
                entries: [entry(2)],
                action: async () => ({ outcome: 'none', detail: '' })
            })
        ).toEqual({ started: false, count: 0, reason: 'already-running' });
        release();
        await until(() => runner.status().running.length === 0);
    });

    it('cancels between entries and flags the recap as cancelled', async () => {
        const bus = new EventBus();
        const logs = captureLogs(bus);
        const runner = new JobRunner();
        runner.runBulk(bus, {
            label: 'Cancellable',
            recapHits: 'x',
            category: 'scan',
            prefix: 'scan.cancel',
            entries: [entry(1), entry(2), entry(3)],
            action: async item => {
                if (item.id === 1) {
                    const current = runner.status().running[0];
                    expect(current).not.toBeUndefined();
                    runner.requestCancel(current?.id ?? 0);
                }
                return { outcome: 'none', detail: 'ok' };
            }
        });
        await until(() => runner.status().running.length === 0);
        const last = runner.status().history[0];
        expect(last).toMatchObject({ cancelled: true, done: 1, total: 3 });
        expect(logs.at(-1)?.code).toBe('scan.cancel.cancelled');
    });

    it('rejects the cancellation of unknown jobs', () => {
        const runner = new JobRunner();
        expect(runner.requestCancel(999)).toBe(false);
    });

    it('tracks custom jobs: update, finish, history', () => {
        const runner = new JobRunner();
        const handle = runner.begin('covers.regenerate', 'Covers', 5);
        expect(handle).not.toBeNull();
        handle?.update({ done: 2, hits: 2, total: 4 });
        handle?.update({ done: 3 });
        expect(runner.status().running[0]).toMatchObject({ done: 3, total: 4, hits: 2, running: true });
        handle?.finish();
        expect(runner.status().running).toHaveLength(0);
        expect(runner.status().history[0]).toMatchObject({ done: 3, total: 4, hits: 2, running: false, cancelled: false });
        // finishing twice stays a no-op: the job is history exactly once
        handle?.finish(true);
        expect(runner.status().history).toHaveLength(1);
        expect(runner.status().history[0]?.cancelled).toBe(false);
    });

    it('runs local jobs concurrently but refuses a second crawl job', () => {
        const runner = new JobRunner();
        const crawl = runner.begin('import.run', 'Import', 10, { crawl: true });
        expect(crawl).not.toBeNull();
        expect(runner.begin('covers.regenerate', 'Covers', 3)).not.toBeNull();
        expect(runner.begin('failover.rematch', 'Re-match', 2, { crawl: true })).toBeNull();
        expect(runner.status().running).toHaveLength(2);
    });

    it('forwards cancellation of custom jobs to onCancel', () => {
        const runner = new JobRunner();
        const onCancel = vi.fn();
        const handle = runner.begin('library.rescan', 'Resync', 1, { onCancel });
        const id = handle?.job.id ?? 0;
        expect(runner.requestCancel(id)).toBe(true);
        expect(onCancel).toHaveBeenCalledTimes(1);
        handle?.finish(true);
        // the finished job no longer matches
        expect(runner.requestCancel(id)).toBe(false);
    });

    it('bounds the history to the most recent jobs', () => {
        const runner = new JobRunner();
        for (let i = 0; i < 12; i++) {
            runner.begin(`kind.${i}`, `Job ${i}`, 1)?.finish();
        }
        const history = runner.status().history;
        expect(history).toHaveLength(10);
        expect(history[0]?.label).toBe('Job 11');
        expect(history.at(-1)?.label).toBe('Job 2');
    });
});
