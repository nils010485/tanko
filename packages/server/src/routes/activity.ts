import type { ActivityStatsDto } from '@tanko/shared';
import type { FastifyInstance } from 'fastify';
import { JobRunner } from '../activity/jobs.js';
import { ACTIVITY_PAGE_SIZE, type ActivityService } from '../activity/service.js';
import type { LibraryStore } from '../library/store.js';
import type { SourceHealthService } from '../sources/health.js';

export function registerActivityRoutes(
    app: FastifyInstance,
    activity: ActivityService,
    stats: { library: LibraryStore; sourceHealth: SourceHealthService },
    /** Shared with the library routes — index.ts passes the same instance. */
    jobs: JobRunner = new JobRunner()
): void {
    // Activity history (checks, notifications, errors) — newest first
    app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/activity', async request => {
        const parsed = Number.parseInt(request.query?.limit || '', 10);
        const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= ACTIVITY_PAGE_SIZE ? parsed : ACTIVITY_PAGE_SIZE;
        const parsedOffset = Number.parseInt(request.query?.offset || '', 10);
        const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
        return { logs: activity.list(limit, offset) };
    });
    // System pulse: library counters, source health, unread errors. The
    // optional `?since=ISO` drives the dashboard's sidebar error badge.
    app.get<{ Querystring: { since?: string } }>('/api/activity/stats', async request => {
        const entries = await stats.library.listEntries('visible');
        const sources = Object.values(stats.sourceHealth.getAll());
        const since = request.query?.since;
        return {
            series: entries.length,
            newChapters7d: activity.newChaptersSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
            activeFailures: entries.filter(entry => (entry.checkFailures ?? 0) > 0).length,
            sourcesHealthy: sources.filter(source => source.status === 'ok').length,
            sourcesTotal: sources.length,
            errorsSince: since !== undefined && !Number.isNaN(Date.parse(since)) ? activity.errorCountSince(since) : undefined
        } satisfies ActivityStatsDto;
    });

    // long-running bulk tools: live progress + cancellation for the dashboard
    app.get('/api/activity/jobs', async () => jobs.status());
    app.post<{ Params: { id: string } }>('/api/activity/jobs/:id/cancel', async (request, reply) => {
        if (!jobs.requestCancel(Number(request.params.id))) {
            return reply.code(409).send({ error: 'Aucun job correspondant en cours' });
        }
        return { ok: true };
    });
}
