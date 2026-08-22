/**
 * GlobalSearchService: fan-out aggregation, per-source error isolation,
 * timeouts and the overall deadline (sources skipped, never dropped).
 */
import type { MangaInfo, SourceAdapter } from '@tanko/core';
import { describe, expect, it } from 'vitest';
import { GlobalSearchService, type GlobalSearchTarget } from '../src/sources/global-search.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fakeAdapter(id: string, search: (query: string) => Promise<MangaInfo[]>): SourceAdapter {
    return {
        id,
        label: `Source ${id}`,
        tags: [],
        kind: 'legacy',
        initialize: async () => undefined,
        searchMangas: search,
        getChapters: async () => [],
        getPages: async () => [],
        checkHealth: async () => ({ ok: true, latencyMs: 1 })
    };
}

function makeService(adapters: SourceAdapter[], targets: GlobalSearchTarget[], overrides?: Partial<ConstructorParameters<typeof GlobalSearchService>[0]>) {
    const byId = new Map(adapters.map(adapter => [adapter.id, adapter]));
    return new GlobalSearchService({
        listSources: async () => targets,
        getAdapter: async id => byId.get(id),
        ...overrides
    });
}

/** Poll until the job reports done (mirrors the dashboard polling). */
async function waitForDone(service: GlobalSearchService, jobId: number) {
    for (;;) {
        const status = service.get(jobId);
        if (status?.done) {
            return status;
        }
        await sleep(10);
    }
}

describe('GlobalSearchService', () => {
    it('aggregates per-source results mapped to MangaDto', async () => {
        const service = makeService(
            [fakeAdapter('a', async () => [{ id: 'm1', title: 'One Piece' }]), fakeAdapter('b', async () => [])],
            [
                { id: 'a', label: 'Source a', kind: 'legacy' },
                { id: 'b', label: 'Source b', kind: 'native' }
            ]
        );
        const { jobId, targets } = await service.start('one');
        expect(targets).toBe(2);
        const status = await waitForDone(service, jobId);
        expect(status.done).toBe(true);
        expect(status.total).toBe(2);
        expect(status.results).toHaveLength(2);
        const a = status.results.find(result => result.sourceId === 'a');
        expect(a?.status).toBe('ok');
        expect(a?.mangas).toEqual([{ sourceId: 'a', id: 'm1', title: 'One Piece' }]);
        expect(status.results.find(result => result.sourceId === 'b')?.status).toBe('ok');
    });

    it('a failing source is reported as error without blocking the others', async () => {
        const service = makeService(
            [
                fakeAdapter('bad', async () => {
                    throw new Error('boom');
                }),
                fakeAdapter('good', async () => [{ id: 'm1', title: 'X' }])
            ],
            [
                { id: 'bad', label: 'Bad', kind: 'legacy' },
                { id: 'good', label: 'Good', kind: 'legacy' }
            ]
        );
        const { jobId } = await service.start('x');
        const status = await waitForDone(service, jobId);
        const bad = status.results.find(result => result.sourceId === 'bad');
        expect(bad?.status).toBe('error');
        expect(bad?.error).toContain('boom');
        expect(status.results.find(result => result.sourceId === 'good')?.status).toBe('ok');
    });

    it('a source slower than its timeout is reported as timeout', async () => {
        const service = makeService([fakeAdapter('slow', () => new Promise<MangaInfo[]>(() => undefined))], [{ id: 'slow', label: 'Slow', kind: 'legacy' }], {
            sourceTimeoutMs: 50
        });
        const { jobId } = await service.start('x');
        const status = await waitForDone(service, jobId);
        expect(status.results[0]?.status).toBe('timeout');
    });

    it('sources not reached before the overall deadline are skipped', async () => {
        const targets = ['s1', 's2', 's3', 's4'].map(id => ({ id, label: id, kind: 'legacy' as const }));
        const adapters = targets.map(target =>
            fakeAdapter(target.id, async () => {
                await sleep(80);
                return [];
            })
        );
        const service = makeService(adapters, targets, { concurrency: 1, overallDeadlineMs: 30 });
        const { jobId } = await service.start('x');
        const status = await waitForDone(service, jobId);
        expect(status.done).toBe(true);
        expect(status.results).toHaveLength(targets.length);
        // the first source consumed the whole deadline: the rest were skipped
        expect(status.results.filter(result => result.status === 'skipped').length).toBeGreaterThanOrEqual(2);
    });
});
