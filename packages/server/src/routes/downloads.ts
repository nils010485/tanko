import type { FastifyInstance } from 'fastify';
import type { DownloadQueue } from '../downloader/queue.js';
import type { SourceRegistry } from '@tanko/core';

export function registerDownloadRoutes(app: FastifyInstance, queue: DownloadQueue, sourceRegistry: SourceRegistry): void {

    // List jobs (active first, then recent history) — paginated & filterable
    const KNOWN_STATUSES = new Set(['queued', 'downloading', 'completed', 'failed', 'cancelled']);
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
    app.post<{ Body: {
        sourceId: string;
        mangaId: string;
        mangaTitle: string;
        chapters: Array<{ id: string; title: string }>;
    } }>('/api/downloads', async (request, reply) => {
        const body = request.body;
        if (!body?.sourceId || !body?.mangaId || !Array.isArray(body?.chapters) || body.chapters.length === 0) {
            return reply.code(400).send({ error: 'Body must contain sourceId, mangaId and a non-empty chapters array' });
        }
        const source = await sourceRegistry.get(body.sourceId);
        if (!source) {
            return reply.code(404).send({ error: `Source "${body.sourceId}" not found` });
        }
        const result = queue.enqueue(body.chapters.map(chapter => ({
            sourceId: body.sourceId,
            mangaId: body.mangaId,
            mangaTitle: body.mangaTitle,
            chapterId: chapter.id,
            chapterTitle: chapter.title
        })));
        return result;
    });

    // Cancel a job (queued or downloading)
    app.delete('/api/downloads/:jobId', async (request, reply) => {
        const { jobId } = request.params as { jobId: string };
        const ok = queue.cancel(Number(jobId));
        if (!ok) {
            return reply.code(404).send({ error: 'Job not found or not cancellable' });
        }
        return { ok: true };
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
}
