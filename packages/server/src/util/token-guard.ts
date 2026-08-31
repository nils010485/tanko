/**
 * Boot-token guard: random per-process token served same-origin by
 * GET /api/bootstrap (no CORS → cross-origin pages cannot read it, hence
 * cannot forge mutations or open /ws). NOT a LAN auth: anyone loading the
 * dashboard gets the token by design.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const TOKEN_HEADER = 'x-tanko-token';

export const apiToken = crypto.randomUUID();

export function registerTokenGuard(app: FastifyInstance): void {
    app.get('/api/bootstrap', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { token: apiToken };
    });

    app.addHook('preHandler', async (request, reply) => {
        if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
            return;
        }
        if (request.headers[TOKEN_HEADER] !== apiToken) {
            return reply.code(403).send({ error: 'Invalid or missing API token' });
        }
    });
}
