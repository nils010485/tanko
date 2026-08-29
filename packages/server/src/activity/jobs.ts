/**
 * Registry + runner for the long-running background jobs: live progress
 * for the dashboard (GET /api/activity/jobs), cancellation and a bounded
 * history of finished runs.
 *
 * Two flavors share one registry:
 *  - `runBulk`: entry-loop tools (re-match, better-source scan) — the loop
 *    runs here with one structured log per entry and 250 ms pacing;
 *  - custom jobs via `begin()`: the caller owns its loop and reports
 *    progress through the returned handle (covers, import, rescan).
 *
 * Concurrency: "crawl" jobs (bulk tools, import) query the source sites —
 * only one crawls at a time. Local jobs (covers, rescan) only touch the
 * disk/database and always start, even while a crawl job runs.
 */
import type { ActivityJobsDto, JobStatusDto, LibraryEntryDto, LogCategory } from '@tanko/shared';
import type { EventBus } from '../ws.js';

/** Outcome keys shared by the bulk tools (dashboard i18n codes). */
export type BulkOutcome = 'migrated' | 'suggested' | 'none' | 'skipped';

export interface BulkAction {
    label: string;
    /** Recap noun for the fallback message, e.g. 'migration(s)'. */
    recapHits: string;
    category: LogCategory;
    /** i18n code prefix, e.g. 'failover.rematch'. */
    prefix: string;
    entries: LibraryEntryDto[];
    action: (entry: LibraryEntryDto) => Promise<{ outcome: BulkOutcome; detail: string; hit?: boolean; level?: 'info' | 'warn' }>;
    /** Webhook hook: the bulk run finished (or was cancelled). */
    notifyFinished?: (summary: { done: number; total: number; hits: number; cancelled: boolean }) => void;
}

/** Live handle over a custom job started with `begin()`. */
export interface JobHandle {
    readonly job: JobStatusDto;
    update(patch: Partial<Pick<JobStatusDto, 'done' | 'hits' | 'total'>>): void;
    finish(cancelled?: boolean): void;
}

interface RegisteredJob {
    job: JobStatusDto;
    /** Crawl jobs query the source sites and exclude each other. */
    crawl: boolean;
    onCancel?: () => void;
}

/** Finished jobs kept for the Activity history, newest first. */
const HISTORY_LIMIT = 10;

export class JobRunner {
    private readonly running = new Map<number, RegisteredJob>();
    private readonly history: JobStatusDto[] = [];
    private readonly cancelRequested = new Set<number>();
    private nextId = 1;

    /** Live snapshot: the running jobs + the most recently finished ones. */
    status(): ActivityJobsDto {
        return { running: [...this.running.values()].map(reg => reg.job), history: [...this.history] };
    }

    /** Flag the running job for cancellation; false when none matches.
     *  Bulk loops stop before their next entry; custom jobs react through
     *  their `onCancel` hook (actions in flight are never aborted). */
    requestCancel(jobId: number): boolean {
        const reg = this.running.get(jobId);
        if (!reg) {
            return false;
        }
        this.cancelRequested.add(jobId);
        reg.onCancel?.();
        return true;
    }

    /** True while a crawl job (bulk tool, import) holds the single crawl slot. */
    crawlBusy(): boolean {
        for (const reg of this.running.values()) {
            if (reg.crawl) {
                return true;
            }
        }
        return false;
    }

    /** Register a custom job (covers, import, rescan) and take its handle.
     *  Returns null when a crawl job is requested while one already runs. */
    begin(kind: string, label: string, total: number, opts: { crawl?: boolean; onCancel?: () => void } = {}): JobHandle | null {
        const crawl = opts.crawl === true;
        if (crawl && this.crawlBusy()) {
            return null;
        }
        const job: JobStatusDto = {
            id: this.nextId++,
            kind,
            label,
            running: true,
            done: 0,
            total,
            hits: 0,
            startedAt: new Date().toISOString()
        };
        this.running.set(job.id, { job, crawl, onCancel: opts.onCancel });
        return {
            job,
            update: patch => Object.assign(job, patch),
            finish: cancelled => this.finish(job, cancelled === true)
        };
    }

    private finish(job: JobStatusDto, cancelled: boolean): void {
        if (!this.running.has(job.id)) {
            return; // finishing twice must stay a no-op
        }
        job.running = false;
        job.cancelled = cancelled;
        job.finishedAt = new Date().toISOString();
        this.running.delete(job.id);
        this.cancelRequested.delete(job.id);
        this.history.unshift(job);
        this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
    }

    /** Sequential loop: start log, one structured log per entry (code =
     *  prefix + outcome), 250 ms pacing, recap — and a single-run guard so
     *  two crawl jobs never hammer the sources concurrently. Returns
     *  immediately; the loop runs in the background. */
    runBulk(events: EventBus, opts: BulkAction): { started: boolean; count: number; reason?: string } {
        if (opts.entries.length === 0) {
            return { started: false, count: 0 };
        }
        const handle = this.begin(opts.prefix, opts.label, opts.entries.length, { crawl: true });
        if (!handle) {
            return { started: false, count: 0, reason: 'already-running' };
        }
        const { job } = handle;
        events.publishLog({
            level: 'info',
            category: opts.category,
            code: `${opts.prefix}.started`,
            params: { total: job.total },
            message: `${opts.label} lancé : ${job.total} série(s)`
        });
        void (async () => {
            try {
                for (const entry of opts.entries) {
                    if (this.cancelRequested.has(job.id)) {
                        break;
                    }
                    try {
                        const result = await opts.action(entry);
                        if (result.hit) {
                            job.hits++;
                        }
                        events.publishLog({
                            level: result.level ?? 'info',
                            category: opts.category,
                            code: `${opts.prefix}.${result.outcome}`,
                            params: { title: entry.title },
                            entryId: entry.id,
                            message: `${opts.label} : « ${entry.title} » → ${result.detail}`
                        });
                    } catch (error) {
                        events.publishLog({
                            level: 'error',
                            category: opts.category,
                            code: `${opts.prefix}.error`,
                            params: { title: entry.title, error: (error as Error).message },
                            entryId: entry.id,
                            message: `${opts.label} « ${entry.title} » : ${(error as Error).message}`
                        });
                    }
                    job.done++;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            } finally {
                const cancelled = this.cancelRequested.has(job.id) && job.done < job.total;
                handle.finish(cancelled);
                events.publishLog({
                    level: 'info',
                    category: opts.category,
                    code: `${opts.prefix}.${cancelled ? 'cancelled' : 'finished'}`,
                    params: { done: job.done, total: job.total, hits: job.hits },
                    message: `${opts.label} ${cancelled ? 'annulé' : 'terminé'} : ${job.done}/${job.total} série(s) traitée(s), ${job.hits} ${opts.recapHits}`
                });
                opts.notifyFinished?.({ done: job.done, total: job.total, hits: job.hits, cancelled });
            }
        })().catch(error => console.warn('[jobs] background run failed:', (error as Error).message));
        return { started: true, count: opts.entries.length };
    }
}
