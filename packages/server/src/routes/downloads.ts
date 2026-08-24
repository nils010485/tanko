import type { SourceRegistry } from '@tanko/core';
import type { FastifyInstance } from 'fastify';
import type { DownloadQueue } from '../downloader/queue.js';
import type { LibraryStore } from '../library/store.js';

export function registerDownloadRoutes(app: FastifyInstance, queue: DownloadQueue, sourceRegistry: SourceRegistry, store?: LibraryStore): void {
    // List jobs (active first, then recent history) — paginated & filterable
    const KNOWN_STATUSES = new Set(['queued', 'downloading', 'completed', 'failed', 'cancelled']);
    // Requeued jobs must flip their library chapter status back to 'queued'
    // ('failed' chapters would otherwise never leave the failed filter).
    const syncChapterStatuses = (chapters: Array<{ entryId: number; chapterId: string }>) => {
        const byEntry = new Map<number, string[]>();
        for (const { entryId, chapterId } of chapters) {
            const list = byEntry.get(entryId) ?? [];
            list.push(chapterId);
            byEntry.set(entryId, list);
        }
        for (const [entryId, chapterIds] of byEntry) {
            store?.markChaptersQueued(entryId, chapterIds);
        }
    };

    app.get<{ Querystring: { limit?: string; offset?: string; status?: string; q?: string } }>('/api/downloads', async request =>
        queue.list({
            limit: request.query.limit ? Number(request.query.limit) : undefined,
            offset: request.query.offset ? Number(request.query.offset) : undefined,
            // ignore unknown status values instead of matching nothing
            status: request.query.status && KNOWN_STATUSES.has(request.query.status) ? request.query.status : undefined,
            query: request.query.q || undefined
        })
    );

    // Queue status (paused / counters)
    app.get('/api/downloads/status', async () => queue.status());

    // Enqueue chapters for download
    // Enqueue chapters for download; when the manga is tracked in the library the
    // queue items carry its entryId so completions update the chapter status
    app.post<{
        Body: {
            sourceId: string;
            mangaId: string;
            mangaTitle: string;
            chapters: Array<{ id: string; title: string }>;
        };
    }>('/api/downloads', async (request, reply) => {
        const body = request.body;
        if (!body?.sourceId || !body?.mangaId || !Array.isArray(body?.chapters) || body.chapters.length === 0) {
            return reply.code(400).send({ error: 'Body must contain sourceId, mangaId and a non-empty chapters array' });
        }
        const source = await sourceRegistry.get(body.sourceId);
        if (!source) {
            return reply.code(404).send({ error: `Source "${body.sourceId}" not found` });
        }
        const entry = store?.findEntryByManga(body.sourceId, body.mangaId) ?? null;
        const result = queue.enqueue(
            body.chapters.map(chapter => ({
                sourceId: body.sourceId,
                mangaId: body.mangaId,
                mangaTitle: body.mangaTitle,
                chapterId: chapter.id,
                chapterTitle: chapter.title,
                entryId: entry?.id
            }))
        );
        if (entry) {
            store?.markChaptersQueued(
                entry.id,
                body.chapters.map(chapter => chapter.id)
            );
        }
        return result;
    });

    // Wipe the finished-job history (completed/failed/cancelled)
    app.delete('/api/downloads/history', async () => ({ removed: queue.clearHistory() }));
    // Cancel a job (queued or downloading)
    app.delete('/api/downloads/:jobId', async (request, reply) => {
        const { jobId } = request.params as { jobId: string };
        const ok = queue.cancel(Number(jobId));
        if (!ok) {
            return reply.code(404).send({ error: 'Job not found or not cancellable' });
        }
        return { ok: true };
    });

    // Requeue every failed job
    app.post('/api/downloads/retry', async () => {
        const result = queue.retryFailed();
        syncChapterStatuses(result.chapters);
        return result;
    });

    // Requeue one finished job (failed or cancelled)
    app.post<{ Params: { jobId: string } }>('/api/downloads/:jobId/retry', async (request, reply) => {
        const { jobId } = request.params as { jobId: string };
        const result = queue.retryJob(Number(jobId));
        if (result.retried === 0) {
            return reply.code(404).send({ error: 'Job not found or not retryable' });
        }
        syncChapterStatuses(result.chapters);
        return result;
    });

    // Pause / resume the whole queue
    app.post('/api/downloads/pause', async () => {
        queue.pause();
        return queue.status();
    });
    app.post('/api/downloads/resume', async () => {
        queue.resume();
        return queue.status();
    });

    // Empty the pending queue (queued deleted, running cancelled; history kept)
    app.post('/api/downloads/clear', async () => {
        const result = queue.clearQueue();
        return { ...result, ...queue.status() };
    });
}
