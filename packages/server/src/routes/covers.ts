/**
 * Cover cache routes: serve the cached WebP covers, expose the regeneration
 * status and trigger a full rebuild (maintenance button in the dashboard).
 */
import type { FastifyInstance } from 'fastify';
import type { CoverService } from '../library/covers.js';

export function registerCoverRoutes(app: FastifyInstance, covers: CoverService): void {
    // cached WebP cover of a library entry (404 when nothing is cached)
    app.get<{ Params: { entryId: string } }>('/api/library/:entryId/cover', async (request, reply) => {
        const entryId = Number(request.params.entryId);
        const data = covers.getCover(entryId);
        if (!data) {
            return reply.code(404).send({ error: 'No cached cover for this entry' });
        }
        return reply.header('Content-Type', 'image/webp').header('Cache-Control', 'public, max-age=300').send(data);
    });

    app.get('/api/library/covers/status', async () => covers.status());
    app.post('/api/library/covers/regenerate', async (_request, reply) => {
        if (!covers.isEnabled()) {
            return reply.code(409).send({ error: 'Cover cache is disabled' });
        }
        return covers.regenerate();
    });
}
