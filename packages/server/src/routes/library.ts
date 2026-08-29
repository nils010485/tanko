/**
 * Library API: facade that registers the focused route modules —
 * library-entries.ts (entry CRUD, aliases, bulk), library-chapters.ts
 * (chapters, checks, enqueue, rollback) and library-migrations.ts
 * (migrations, rematches, suggestions) — plus the scheduler routes.
 */
import type { LibraryEntryDto } from '@tanko/shared';
import type { FastifyInstance } from 'fastify';
import { JobRunner } from '../activity/jobs.js';
import type { DownloadQueue } from '../downloader/queue.js';
import type { CoverService } from '../library/covers.js';
import type { FailoverService } from '../library/failover.js';
import type { LibraryStore } from '../library/store.js';
import type { Scheduler, ScheduleSettings } from '../scheduler/scheduler.js';
import type { EventBus } from '../ws.js';
import { registerLibraryChaptersRoutes } from './library-chapters.js';
import { registerLibraryEntriesRoutes } from './library-entries.js';
import { registerLibraryMigrationsRoutes } from './library-migrations.js';

/** Shared dependencies of the library route modules (entries/chapters/migrations). */
export interface LibraryRouteDeps {
    store: LibraryStore;
    scheduler: Scheduler;
    queue: DownloadQueue;
    events: EventBus;
    failover?: FailoverService;
    covers?: CoverService;
    /** Shared with the activity routes — index.ts passes the same instance. */
    jobs: JobRunner;
    /** Re-read an entry and broadcast it to the dashboard (no-op when it vanished). */
    publishEntry(entryId: number): LibraryEntryDto | undefined;
}

/** Shape accepted by Scheduler.updateSettings (notifications may be partial). */
type SchedulePatch = Partial<Omit<ScheduleSettings, 'notifications'>> & { notifications?: Partial<ScheduleSettings['notifications']> };

export function registerLibraryRoutes(
    app: FastifyInstance,
    store: LibraryStore,
    scheduler: Scheduler,
    queue: DownloadQueue,
    events: EventBus,
    failover?: FailoverService,
    covers?: CoverService,
    jobs: JobRunner = new JobRunner()
): void {
    /** Re-read an entry and broadcast it to the dashboard (no-op when it vanished). */
    const publishEntry = (entryId: number): LibraryEntryDto | undefined => {
        const entry = store.getEntry(entryId);
        if (entry) {
            events.publish({ type: 'library.updated', entry });
        }
        return entry;
    };

    const deps: LibraryRouteDeps = { store, scheduler, queue, events, failover, covers, jobs, publishEntry };
    registerLibraryEntriesRoutes(app, deps);
    registerLibraryChaptersRoutes(app, deps);
    registerLibraryMigrationsRoutes(app, deps);

    // ------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------

    app.get('/api/schedule', async () => ({ settings: scheduler.getSettings(), status: scheduler.status() }));

    app.patch<{ Body: SchedulePatch }>('/api/schedule', async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object') {
            return reply.code(400).send({ error: 'Body must be an object' });
        }
        try {
            return { settings: scheduler.updateSettings(body), status: scheduler.status() };
        } catch (error) {
            return reply.code(400).send({ error: (error as Error).message });
        }
    });

    // Trigger a full check of all entries right now
    app.post('/api/schedule/run', async () => {
        const result = await scheduler.runNow();
        return result;
    });
}
