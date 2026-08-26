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
        await until(() => runner.status().current === null && runner.status().last !== null);
        const last = runner.status().last;
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
        await until(() => runner.status().current === null);
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
                    const current = runner.status().current;
                    expect(current).not.toBeNull();
                    runner.requestCancel(current?.id ?? 0);
                }
                return { outcome: 'none', detail: 'ok' };
            }
        });
        await until(() => runner.status().current === null);
        const last = runner.status().last;
        expect(last).toMatchObject({ cancelled: true, done: 1, total: 3 });
        expect(logs.at(-1)?.code).toBe('scan.cancel.cancelled');
    });

    it('rejects the cancellation of unknown jobs', () => {
        const runner = new JobRunner();
        expect(runner.requestCancel(999)).toBe(false);
    });
});
