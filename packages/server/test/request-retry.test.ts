/**
 * HeadlessRequest.fetch rate-limit handling: 429 responses must be retried
 * honoring Retry-After (bounded), within the caller's timeout budget.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadlessRequest, retryAfterMs } from '@tanko/core';
import { describe, expect, it } from 'vitest';

/** Counting server: answers with the scripted statuses in order (last one repeats). */
function scriptedServer(script: Array<{ status: number; headers?: Record<string, string> }>) {
    let hits = 0;
    const server = http.createServer((_request, response) => {
        const step = script[Math.min(hits, script.length - 1)];
        hits++;
        response.writeHead(step.status, step.headers);
        response.end('body');
    });
    return {
        start: () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)),
        url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`,
        hits: () => hits,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
}

describe('retryAfterMs', () => {
    it('parses delay-seconds', () => {
        expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '2' } }))).toBe(2000);
    });

    it('parses HTTP-dates relative to now', () => {
        const ms = retryAfterMs(new Response(null, { headers: { 'retry-after': new Date(Date.now() + 3000).toUTCString() } }));
        expect(ms).toBeGreaterThanOrEqual(2000);
        expect(ms).toBeLessThanOrEqual(3000);
    });

    it('clamps long hints to the 15s ceiling', () => {
        expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '3600' } }))).toBe(15000);
    });

    it('returns undefined when absent or unparseable', () => {
        expect(retryAfterMs(new Response(null, {}))).toBeUndefined();
        expect(retryAfterMs(new Response(null, { headers: { 'retry-after': 'next tuesday' } }))).toBeUndefined();
    });
});

describe('HeadlessRequest.fetch rate-limit retry', () => {
    it('retries a 429 honoring Retry-After, then returns the 200', async () => {
        const server = scriptedServer([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
        await server.start();
        try {
            const response = await new HeadlessRequest().fetch(server.url());
            expect(response.status).toBe(200);
            expect(server.hits()).toBe(2);
        } finally {
            await server.close();
        }
    });

    it('gives up after the retry budget when the server keeps throttling', async () => {
        const server = scriptedServer([{ status: 429 }]); // no Retry-After -> fixed backoff
        await server.start();
        try {
            const response = await new HeadlessRequest().fetch(server.url());
            expect(response.status).toBe(429);
            expect(server.hits()).toBe(3); // RATE_LIMIT_ATTEMPTS
        } finally {
            await server.close();
        }
    }, 15000);

    it('returns the throttling response when the wait cannot fit the timeout budget', async () => {
        const server = scriptedServer([{ status: 429, headers: { 'retry-after': '60' } }]);
        await server.start();
        try {
            const response = await new HeadlessRequest().fetch(server.url(), 500);
            expect(response.status).toBe(429);
            expect(server.hits()).toBe(1); // capped 15s wait > 500ms budget: no retry
        } finally {
            await server.close();
        }
    });
});
