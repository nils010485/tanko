/**
 * Global (all visible sources) manga search for the Discover tab.
 *
 * A job fans out to every non-hidden source through a bounded worker pool
 * (pattern of ImportService): cached legacy lists resolve instantly, uncached
 * ones get one catalog fetch (warming the 24h cache), native endpoints answer
 * their own search API. Each source gets a wall-clock timeout and the whole
 * job a deadline — sources that don't fit are reported 'skipped', never
 * silently dropped. The dashboard polls get() for progressive results.
 */

import type { MangaInfo, SourceAdapter } from '@tanko/core';
import type { GlobalSearchSourceResultDto, GlobalSearchStatusDto } from '@tanko/shared';
import { mangaLanguagesAllowed, sourceUsable } from '../languages.js';

const CONCURRENCY = 16;
/** Per-source wall-clock budget (clamped to the remaining overall deadline). */
const SOURCE_TIMEOUT_MS = 12_000;
/** Overall budget after which remaining sources are skipped. Generous on
 *  purpose: "search everywhere" must actually reach every visible source. */
const OVERALL_DEADLINE_MS = 180_000;
/** Result cap per source (the UI groups by source, 20 cards is plenty). */
const RESULTS_PER_SOURCE = 20;
/** Finished jobs stay pollable for a while, then are purged. */
const JOB_RETENTION_MS = 5 * 60_000;

export interface GlobalSearchTarget {
    id: string;
    label: string;
    kind: 'legacy' | 'native';
    /** Source tags, used to detect preferred-language mismatches. */
    tags?: string[];
}

interface GlobalSearchJob {
    id: number;
    query: string;
    done: boolean;
    targets: GlobalSearchTarget[];
    results: GlobalSearchSourceResultDto[];
}

export class GlobalSearchService {
    private readonly jobs = new Map<number, GlobalSearchJob>();
    private nextJobId = 1;

    constructor(
        private readonly opts: {
            listSources: () => Promise<GlobalSearchTarget[]>;
            getAdapter: (id: string) => Promise<SourceAdapter | undefined>;
            /** Preferred chapter languages (ISO codes); empty = no filter (all). */
            getPreferredLanguages?: () => string[];
            /** Timing overrides for tests (fast budgets); defaults are production-tuned. */
            concurrency?: number;
            sourceTimeoutMs?: number;
            overallDeadlineMs?: number;
        }
    ) {}

    /** Start a search job; results accumulate in the background. */
    async start(query: string): Promise<{ jobId: number; targets: number }> {
        const targets = await this.opts.listSources();
        const job: GlobalSearchJob = { id: this.nextJobId++, query, done: false, targets, results: [] };
        this.jobs.set(job.id, job);
        void this._run(job).finally(() => {
            const timer = setTimeout(() => this.jobs.delete(job.id), JOB_RETENTION_MS);
            timer.unref();
        });
        return { jobId: job.id, targets: targets.length };
    }

    /** Polling snapshot; undefined once the job has been purged. */
    get(jobId: number): GlobalSearchStatusDto | undefined {
        const job = this.jobs.get(jobId);
        if (!job) {
            return undefined;
        }
        return {
            jobId: job.id,
            query: job.query,
            total: job.targets.length,
            completed: job.results.length,
            done: job.done,
            results: [...job.results]
        };
    }

    private async _run(job: GlobalSearchJob): Promise<void> {
        const deadline = Date.now() + (this.opts.overallDeadlineMs ?? OVERALL_DEADLINE_MS);
        const sourceTimeout = this.opts.sourceTimeoutMs ?? SOURCE_TIMEOUT_MS;
        // native adapters answer fast and reliably: schedule them first so
        // useful results appear early in the progressive UI
        const pending = [...job.targets].sort((a, b) => Number(b.kind === 'native') - Number(a.kind === 'native'));
        const worker = async (): Promise<void> => {
            for (;;) {
                if (Date.now() >= deadline) {
                    return;
                }
                const target = pending.shift();
                if (!target) {
                    return;
                }
                await this._searchSource(job, target, deadline, sourceTimeout);
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? CONCURRENCY, pending.length) }, worker));
        for (const target of pending) {
            job.results.push({ sourceId: target.id, sourceLabel: target.label, kind: target.kind, status: 'skipped', mangas: [] });
        }
        job.done = true;
    }

    private async _searchSource(job: GlobalSearchJob, target: GlobalSearchTarget, deadline: number, sourceTimeout: number): Promise<void> {
        const startedAt = Date.now();
        let timedOut = false;
        try {
            const adapter = await this.opts.getAdapter(target.id);
            if (!adapter) {
                throw new Error('source not available');
            }
            const budget = Math.max(1, Math.min(sourceTimeout, deadline - Date.now()));
            const mangas = await new Promise<MangaInfo[]>((resolve, reject) => {
                const timer = setTimeout(() => {
                    timedOut = true;
                    reject(new Error('source search timed out'));
                }, budget);
                timer.unref();
                adapter.searchMangas(job.query).then(
                    value => {
                        clearTimeout(timer);
                        resolve(value);
                    },
                    error => {
                        clearTimeout(timer);
                        reject(error);
                    }
                );
            });
            // native MangaDex search emits one entry per title/alt-title (import
            // matching relies on it): display dedupes back to one card per manga
            const unique = new Map<string, (typeof mangas)[number]>();
            for (const manga of mangas) {
                if (!unique.has(String(manga.id))) {
                    unique.set(String(manga.id), manga);
                }
            }
            const preferred = this.opts.getPreferredLanguages?.() || [];
            job.results.push({
                sourceId: target.id,
                sourceLabel: target.label,
                kind: target.kind,
                status: 'ok',
                tookMs: Date.now() - startedAt,
                // titles known to lack chapters in the preferred languages
                // (native MangaDex metadata) are dropped instead of looking
                // empty later; sources without the preferred language at all
                // are flagged so the UI can de-emphasize rather than hide them
                outOfLanguages: (preferred.length > 0 && !sourceUsable(target.tags || [], preferred)) || undefined,
                mangas: [...unique.values()]
                    .filter(manga => mangaLanguagesAllowed(manga.languages, preferred))
                    .slice(0, RESULTS_PER_SOURCE)
                    .map((manga): GlobalSearchSourceResultDto['mangas'][number] => ({
                        sourceId: target.id,
                        id: manga.id,
                        title: manga.title,
                        url: manga.url,
                        thumbnail: manga.thumbnail
                    }))
            });
        } catch (error) {
            job.results.push({
                sourceId: target.id,
                sourceLabel: target.label,
                kind: target.kind,
                status: timedOut ? 'timeout' : 'error',
                tookMs: Date.now() - startedAt,
                error: String((error as Error)?.message || error),
                mangas: []
            });
        }
    }
}
