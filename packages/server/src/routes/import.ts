import type { FastifyInstance, FastifyReply } from 'fastify';
import { scanLibrary } from '../import/scanner.js';
import type { AutoConfirmMode, ImportService } from '../import/service.js';

const AUTO_CONFIRM_MODES = new Set<AutoConfirmMode>(['auto', 'all', 'none']);

/** Shared body for resume/sync: run the action, 404 with the thrown message when the job is unknown. */
async function runJobAction(reply: FastifyReply, _importer: ImportService, id: string, action: (jobId: number) => Promise<void>) {
    try {
        await action(Number(id));
        return { ok: true };
    } catch (error) {
        return reply.code(404).send({ error: (error as Error).message });
    }
}

export function registerImportRoutes(app: FastifyInstance, importer: ImportService): void {
    // Scan a data folder and detect series/chapters (preview, no mutation)
    app.post<{ Body: { path: string } }>('/api/import/scan', async (request, reply) => {
        const targetPath = request.body?.path;
        if (!targetPath || typeof targetPath !== 'string') {
            return reply.code(400).send({ error: 'Le champ "path" est requis' });
        }
        try {
            const result = scanLibrary(targetPath);
            return {
                root: result.root,
                totalChapters: result.totalChapters,
                truncated: result.truncated,
                series: result.series.map(series => ({
                    name: series.name,
                    path: series.path,
                    chapterCount: series.chapterCount,
                    metaName: series.metaName,
                    numbers: series.chapters
                        .map(chapter => chapter.number)
                        .filter((value): value is number => value !== null)
                        .sort((a, b) => a - b),
                    sample: series.chapters.slice(0, 5).map(chapter => chapter.file)
                }))
            };
        } catch (error) {
            return reply.code(400).send({ error: (error as Error).message });
        }
    });

    // Start a persistent import job: scan + match (+ auto-confirm/sync per options)
    app.post<{ Body: { path: string; autoConfirm?: AutoConfirmMode; autoDownload?: boolean; concurrency?: number; sourceIds?: string[] } }>(
        '/api/import/jobs',
        async (request, reply) => {
            const body = request.body;
            if (!body?.path || typeof body.path !== 'string') {
                return reply.code(400).send({ error: 'Le champ "path" est requis' });
            }
            if (body.autoConfirm !== undefined && !AUTO_CONFIRM_MODES.has(body.autoConfirm)) {
                return reply.code(400).send({ error: 'autoConfirm doit être "auto", "all" ou "none"' });
            }
            try {
                return await importer.start(body.path, {
                    autoConfirm: body.autoConfirm,
                    autoDownload: body.autoDownload === true,
                    concurrency: body.concurrency,
                    sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : undefined
                });
            } catch (error) {
                return reply.code(400).send({ error: (error as Error).message });
            }
        }
    );

    // Latest job status (dashboard polling; survives tab close / server restart)
    app.get('/api/import/jobs/current', async () => importer.status());

    // Resume an interrupted or ready job (pending series are re-matched, confirmed ones synced)
    app.post<{ Params: { id: string } }>('/api/import/jobs/:id/resume', (request, reply) =>
        runJobAction(reply, importer, request.params.id, id => importer.resume(id))
    );

    app.post<{ Params: { id: string } }>('/api/import/jobs/:id/cancel', async request => {
        importer.cancel(Number(request.params.id));
        return { ok: true };
    });

    // Confirm matches in bulk: 'auto' = high-confidence only, 'all' = review-tier too
    app.post<{ Params: { id: string }; Body: { mode?: AutoConfirmMode } }>('/api/import/jobs/:id/confirm', async request => {
        const mode = request.body?.mode === 'all' ? 'all' : 'auto';
        const confirmed = importer.confirm(Number(request.params.id), mode);
        return { confirmed };
    });

    // Manually confirm/correct one series
    app.post<{ Params: { id: string }; Body: { path: string; sourceId: string; sourceLabel: string; mangaId: string; mangaTitle: string } }>(
        '/api/import/jobs/:id/choose',
        async (request, reply) => {
            const body = request.body;
            if (!body?.path || !body.sourceId || !body.mangaId || !body.mangaTitle) {
                return reply.code(400).send({ error: 'Champs requis: path, sourceId, mangaId, mangaTitle' });
            }
            importer.choose(Number(request.params.id), body.path, {
                sourceId: body.sourceId,
                sourceLabel: body.sourceLabel || body.sourceId,
                mangaId: body.mangaId,
                mangaTitle: body.mangaTitle
            });
            return { ok: true };
        }
    );

    // Sync all confirmed series into the library (background)
    app.post<{ Params: { id: string } }>('/api/import/jobs/:id/sync', (request, reply) =>
        runJobAction(reply, importer, request.params.id, id => importer.sync(id))
    );
}
