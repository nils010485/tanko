import type { FastifyInstance } from 'fastify';
// build-time import: process.env.npm_package_version is only set under npm
// lifecycles, not under the Docker CMD (node packages/server/dist/index.js)
import pkg from '../../package.json' with { type: 'json' };

export function registerHealthRoutes(app: FastifyInstance): void {
    app.get('/health', async () => ({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        version: process.env.npm_package_version || pkg.version,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }));
}
