/**
 * Registry + runner for the long-running background jobs (bulk failover
 * tools): live progress for the dashboard (GET /api/activity/jobs) and
 * cancellation. Single-run guard: only one bulk job crawls the sources at
 * a time.
 */
import type { JobStatusDto, LibraryEntryDto, LogCategory } from '@tanko/shared';
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

export class JobRunner {
    private current: JobStatusDto | null = null;
    private last: JobStatusDto | null = null;
    private nextId = 1;
    private cancelled = false;

    /** Live snapshot: the running job + the last finished one. */
    status(): { current: JobStatusDto | null; last: JobStatusDto | null } {
        return { current: this.current, last: this.last };
    }

    /** Flag the running job for cancellation; false when none matches.
     *  The loop stops before its next entry (actions are not aborted). */
    requestCancel(jobId: number): boolean {
        if (!this.current || this.current.id !== jobId) {
            return false;
        }
        this.cancelled = true;
        return true;
    }

    /** Sequential loop: start log, one structured log per entry (code =
     *  prefix + outcome), 250 ms pacing, recap — and a single-run guard so
     *  two bulk jobs never crawl the sources concurrently. Returns
     *  immediately; the loop runs in the background. */
    runBulk(events: EventBus, opts: BulkAction): { started: boolean; count: number; reason?: string } {
        if (this.current) {
            return { started: false, count: 0, reason: 'already-running' };
        }
        if (opts.entries.length === 0) {
            return { started: false, count: 0 };
        }
        this.cancelled = false;
        const job: JobStatusDto = {
            id: this.nextId++,
            kind: opts.prefix,
            label: opts.label,
            running: true,
            done: 0,
            total: opts.entries.length,
            hits: 0,
            startedAt: new Date().toISOString()
        };
        this.current = job;
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
                    if (this.cancelled) {
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
                job.running = false;
                job.cancelled = this.cancelled && job.done < job.total;
                job.finishedAt = new Date().toISOString();
                this.current = null;
                this.last = job;
                events.publishLog({
                    level: 'info',
                    category: opts.category,
                    code: `${opts.prefix}.${job.cancelled ? 'cancelled' : 'finished'}`,
                    params: { done: job.done, total: job.total, hits: job.hits },
                    message: `${opts.label} ${job.cancelled ? 'annulé' : 'terminé'} : ${job.done}/${job.total} série(s) traitée(s), ${job.hits} ${opts.recapHits}`
                });
                opts.notifyFinished?.({ done: job.done, total: job.total, hits: job.hits, cancelled: job.cancelled });
            }
        })().catch(error => console.warn('[jobs] background run failed:', (error as Error).message));
        return { started: true, count: opts.entries.length };
    }
}
