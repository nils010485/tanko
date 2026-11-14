/**
 * Regression tests for the page-fetch fallback contract (bug seen on
 * 2026-09-02): a native connector whose fetchPageImage failed with a real
 * HTTP error must NOT trigger the Referer-less raw fetch (pointless extra
 * hit on an already rate-limited CDN, masked error). Only browser-session
 * connectors opting out with 'not in browser mode' fall back to raw fetch.
 */

import { LegacySourceAdapter, NOT_IN_BROWSER_MODE, type SourceAdapter, SourceError } from '@tanko/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CachedSourceAdapter } from '../src/cache/cached-adapter.js';
import { fetchPageWithRetries } from '../src/downloader/pages.js';
import { DomainGate } from '../src/downloader/rate-limiter.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** The image path never touches the cache: a no-op store satisfies the decorator. */
const fakeCache = { get: async () => undefined, set: async () => {}, delete: async () => {}, clear: async () => 0 } as never;

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
        const fetchPageImage = vi.fn(async () => {
            throw new SourceError('HTTP 429 fetching page image on ComicK (comick)', 'comick');
        });
        const source = {
            id: 'comick',
            label: 'ComicK',
            kind: 'native',
            fetchPageImage
        } as unknown as SourceAdapter;
        let error: unknown;
        await drain(fetchPageWithRetries('https://cdn1.comicknew.pictures/a/17.webp', source, new DomainGate(0)).catch(e => (error = e)));
        expect((error as Error).message).toContain('HTTP 429');
        // the doomed Referer-less raw fetch must never run
        expect(rawFetch).not.toHaveBeenCalled();
        // 3 outer attempts, each routed to the connector
        expect(fetchPageImage).toHaveBeenCalledTimes(3);
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

    it('routes through fetchPageImage even when wrapped by the caching decorator', async () => {
        const rawFetch = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('fetch', rawFetch);
        const fetchPageImage = vi.fn(async () => ({ mime: 'image/png', data: new Uint8Array(PNG) }));
        const inner = { id: 'x', label: 'X', kind: 'native', url: 'https://example.manga', fetchPageImage } as unknown as SourceAdapter;
        const wrapped = new CachedSourceAdapter(inner, fakeCache);
        const page = await fetchPageWithRetries('https://example.manga/01.webp', wrapped, new DomainGate(0));
        expect(page.mime).toBe('image/png');
        expect(fetchPageImage).toHaveBeenCalledTimes(1);
        expect(rawFetch).not.toHaveBeenCalled();
    });

    it('uses the legacy engine bridge through the caching decorator', async () => {
        const engineFetch = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
        vi.stubGlobal('Engine', { Request: { fetch: engineFetch } });
        const rawFetch = vi.fn();
        vi.stubGlobal('fetch', rawFetch);
        const connector = { id: 'legacy', label: 'Legacy', url: 'https://legacy.example', requestOptions: {} } as never;
        const wrapped = new CachedSourceAdapter(new LegacySourceAdapter(connector), fakeCache);
        const page = await fetchPageWithRetries('https://legacy.example/01.jpg', wrapped, new DomainGate(0));
        expect(page.mime).toBe('image/png');
        expect(engineFetch).toHaveBeenCalledTimes(1);
        expect(rawFetch).not.toHaveBeenCalled();
    });
});
