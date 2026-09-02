/**
 * Regression tests for the page-fetch fallback contract (bug seen on
 * 2026-09-02): a native connector whose fetchPageImage failed with a real
 * HTTP error must NOT trigger the Referer-less raw fetch (pointless extra
 * hit on an already rate-limited CDN, masked error). Only browser-session
 * connectors opting out with 'not in browser mode' fall back to raw fetch.
 */

import { NOT_IN_BROWSER_MODE, SourceError } from '@tanko/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPageWithRetries } from '../src/downloader/pages.js';
import { DomainGate } from '../src/downloader/rate-limiter.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Drain the retry backoffs (fetchPageWithRetries + gate) under fake timers. */
async function drain(promise: Promise<unknown>, rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await vi.advanceTimersByTimeAsync(1000);
    }
    await promise;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('fetchPageWithRetries fallback contract', () => {
    it('propagates the fetchPageImage failure without a raw fetch (HTTP error)', async () => {
        vi.useFakeTimers();
        const rawFetch = vi.fn();
        vi.stubGlobal('fetch', rawFetch);
        const source = {
            id: 'comick',
            label: 'ComicK',
            kind: 'native',
            fetchPageImage: vi.fn(async () => {
                throw new SourceError('HTTP 429 fetching page image on ComicK (comick)', 'comick');
            })
        } as never;
        let error: unknown;
        await drain(fetchPageWithRetries('https://cdn1.comicknew.pictures/a/17.webp', source, new DomainGate(0)).catch(e => (error = e)));
        expect((error as Error).message).toContain('HTTP 429');
        // the doomed Referer-less raw fetch must never run
        expect(rawFetch).not.toHaveBeenCalled();
        // 3 outer attempts, each routed to the connector
        expect(source.fetchPageImage).toHaveBeenCalledTimes(3);
    });

    it('falls back to the raw fetch for browser-session opt-outs', async () => {
        vi.useFakeTimers();
        const rawFetch = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('fetch', rawFetch);
        const source = {
            id: 'madara-ish',
            label: 'Madara-ish',
            kind: 'native',
            url: 'https://example.manga',
            fetchPageImage: vi.fn(async () => {
                throw new Error(NOT_IN_BROWSER_MODE);
            })
        } as never;
        const page = await fetchPageWithRetries('https://example.manga/wp-content/uploads/01.webp', source, new DomainGate(0));
        expect(page.mime).toBe('image/png');
        expect(rawFetch).toHaveBeenCalledTimes(1);
    });
});
