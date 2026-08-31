import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiToken, registerTokenGuard, TOKEN_HEADER } from '../src/util/token-guard.js';

let app: FastifyInstance;

beforeAll(async () => {
    app = Fastify();
    registerTokenGuard(app);
    app.get('/api/read', async () => ({ ok: true }));
    app.post('/api/mutate', async () => ({ ok: true }));
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

describe('token guard', () => {
    it('serves the boot token on GET /api/bootstrap without auth', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/bootstrap' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ token: apiToken });
        expect(response.headers['cache-control']).toContain('no-store');
    });

    it('lets GETs through without a token', async () => {
        const response = await app.inject({ method: 'GET', url: '/api/read' });
        expect(response.statusCode).toBe(200);
    });

    it('rejects mutations without or with a wrong token', async () => {
        const missing = await app.inject({ method: 'POST', url: '/api/mutate' });
        expect(missing.statusCode).toBe(403);
        const wrong = await app.inject({ method: 'POST', url: '/api/mutate', headers: { [TOKEN_HEADER]: 'nope' } });
        expect(wrong.statusCode).toBe(403);
    });

    it('accepts mutations echoing the boot token', async () => {
        const response = await app.inject({ method: 'POST', url: '/api/mutate', headers: { [TOKEN_HEADER]: apiToken } });
        expect(response.statusCode).toBe(200);
    });
});
