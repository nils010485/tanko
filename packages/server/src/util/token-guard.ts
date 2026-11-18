/**
 * Boot-token guard: random per-process token served same-origin by
 * GET /api/bootstrap (no CORS → cross-origin pages cannot read it, hence
 * cannot forge mutations or open /ws). NOT a LAN auth: anyone loading the
 * dashboard gets the token by design.
 */
import crypto from 'node:crypto';
import { type BootstrapDto, TOKEN_HEADER } from '@tanko/shared';
import type { FastifyInstance } from 'fastify';
import type { OidcAuthService } from '../auth/oidc.js';

export const apiToken = crypto.randomUUID();

export function registerTokenGuard(app: FastifyInstance, auth?: OidcAuthService): void {
    app.get('/api/bootstrap', async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (!auth) {
            return { token: apiToken, authEnabled: false } satisfies BootstrapDto;
        }
        const session = auth.sessionFromRequest(request);
        if (!session) {
            return reply.code(401).send({ error: 'Authentication required', authEnabled: true });
        }
        return {
            token: apiToken,
            authEnabled: true,
            user: { name: session.name, email: session.email }
        } satisfies BootstrapDto;
    });

    app.addHook('preHandler', async (request, reply) => {
        if (auth) {
            const path = request.url.split('?', 1)[0];
            const isApi = path === '/api' || path.startsWith('/api/');
            if (isApi && path !== '/api/bootstrap' && !auth.sessionFromRequest(request)) {
                return reply.code(401).send({ error: 'Authentication required' });
            }
        }
        if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
            return;
        }
        if (request.headers[TOKEN_HEADER] !== apiToken) {
            return reply.code(403).send({ error: 'Invalid or missing API token' });
        }
    });
}
