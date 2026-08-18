import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
    app.get('/health', async () => ({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        version: (process.env.npm_package_version as string) || '0.1.0',
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    }));
}
