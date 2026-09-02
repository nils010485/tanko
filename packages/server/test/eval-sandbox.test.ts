/**
 * Containment contract of the page-script evaluation sandbox
 * (HeadlessRequest._evaluateInPage → isolated evaluation child).
 *
 * The sandbox intentionally runs in a dedicated child process: a remote page
 * script must never reach the server process (env, fs, cookie jar). These
 * tests encode the contract — they fail if the evaluation falls back
 * in-process (TANKO_EVAL_INPROCESS=1), which is exactly the point.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeadlessRequest } from '@tanko/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const EMPTY_PAGE = '<html><head><title>t</title></head><body>content</body></html>';

describe('evaluation sandbox isolation', () => {
    it('does not expose the host process to page scripts', async () => {
        const result = await new HeadlessRequest()._evaluateInPage('https://page.test/a', EMPTY_PAGE, 'typeof process', 15000);
        expect(result).toBe('undefined');
    });

    it('closes the realm-intrinsic escape (Promise.constructor → process)', async () => {
        const script = `(() => {
            try {
                const host = Promise.constructor('return process')();
                return host && host.version ? 'LEAK:' + host.version : 'contained';
            } catch {
                return 'contained';
            }
        })()`;
        const result = await new HeadlessRequest()._evaluateInPage('https://page.test/b', EMPTY_PAGE, script, 15000);
        expect(result).toBe('contained');
    });

    it('keeps prototype-chain bridges out of the server environment', async () => {
        // any object handed to the context (document, timers…) is a bridge to
        // the outer realm — the child's env must be wiped, so the marker can
        // never show up on the other side
        process.env.TANKO_TEST_MARKER = 'leak-canary';
        try {
            const script = `(() => {
                try {
                    const HostFunction = document.constructor.constructor;
                    return String(HostFunction('return JSON.stringify(process.env)')());
                } catch (error) {
                    return 'bridge refused: ' + String(error);
                }
            })()`;
            const result = await new HeadlessRequest()._evaluateInPage('https://page.test/c', EMPTY_PAGE, script, 15000);
            expect(String(result)).not.toContain('leak-canary');
            expect(String(result)).not.toContain(process.version);
        } finally {
            delete process.env.TANKO_TEST_MARKER;
        }
    });

    it('still runs inline page scripts before the connector snippet', async () => {
        const html = `<html><head><title>t</title></head><body>
            <script>window.ts_reader = { getData: function () { return { pages: ['a', 'b'] }; } };</script>
        </body></html>`;
        const result = await new HeadlessRequest()._evaluateInPage('https://page.test/d', html, 'ts_reader.getData()', 15000);
        expect(result).toEqual({ pages: ['a', 'b'] });
    });

    it('times out a snippet that never settles', async () => {
        await expect(new HeadlessRequest()._evaluateInPage('https://page.test/e', EMPTY_PAGE, 'new Promise(function () {})', 700)).rejects.toThrow(
            /script evaluation timed out/
        );
    });

    describe('sandbox fetch/ajax ride the session transport', () => {
        let server: ReturnType<typeof countingServer>;
        beforeAll(async () => {
            server = countingServer();
            await server.start();
        });
        afterAll(async () => {
            await server.close();
        });

        it('proxies $.ajax through the parent (relative URL, page referer)', async () => {
            const script = '$.ajax("/data").then(function (text) { return text; })';
            const result = await new HeadlessRequest()._evaluateInPage(server.url(), EMPTY_PAGE, script, 15000);
            expect(result).toBe('ajax-body');
            expect(server.requests()).toBeGreaterThanOrEqual(1);
            expect(server.lastReferer()).toBe(server.url());
        });
    });
});

/** Tiny origin server answering /data — used to observe the proxied subrequest. */
function countingServer() {
    let hits = 0;
    let referer = '';
    const server = http.createServer((request, response) => {
        hits++;
        referer = String(request.headers.referer ?? '');
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ajax-body');
    });
    return {
        start: () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)),
        url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`,
        requests: () => hits,
        lastReferer: () => referer,
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    };
}
