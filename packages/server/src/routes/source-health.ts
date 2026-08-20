import type { FastifyInstance } from 'fastify';
import type { SourceHealthService } from '../sources/health.js';

export function registerSourceHealthRoutes(app: FastifyInstance, health: SourceHealthService): void {
    // All health records (sourceId -> status)
    app.get('/api/sources/health', async () => health.getAll());

    // Trigger checks: specific sources (body.sourceIds) or all sources
    app.post<{ Body: { sourceIds?: string[] } }>('/api/sources/health/check', async (request, reply) => {
        const sourceIds = request.body?.sourceIds;
        if (sourceIds && (!Array.isArray(sourceIds) || sourceIds.length === 0)) {
            return reply.code(400).send({ error: 'sourceIds must be a non-empty array when provided' });
        }
        // run in background, respond immediately with current state
        const run = sourceIds ? health.probeMany(sourceIds) : health.probeAll();
        void run
            .then(summary => console.log(`[health] probe finished: ${summary.ok}/${summary.checked} ok (${summary.errors} errors)`))
            .catch(error => console.error('[health] probe failed:', error));
        return reply.code(202).send({ started: true, targets: sourceIds?.length || 'all' });
    });
}
