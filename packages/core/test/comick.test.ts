/**
 * Regression tests for the ComicK connector, pinning the two bugs seen on
 * 2026-09-02:
 *  - getPages is called by the download queue with {id, title} only (no url):
 *    the reader URL must be rebuilt from the bare hid (the reader resolves
 *    chapters by hid; slug/chap/lang path segments are decorative).
 *  - cdn1 429 bursts: fetchPageImage retries with backoff, then surfaces a
 *    SourceError instead of crashing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comick } from '../src/sources/native/comick.js';
import { SourceError } from '../src/sources/types.js';

const HID = 'jYDIYE5p';

/** Minimal comick.art reader HTML embedding an sv-data script. Padded past
 *  isAntiBotShell's thin-page threshold (1 KB). */
function readerHtml(urls: string[]): string {
    const sv = JSON.stringify({ chapter: { images: urls.map(url => ({ url })) } });
    const filler = `<!-- ${'x'.repeat(1200)} -->`;
    return `<!doctype html><html><body>${filler}<script id="sv-data" type="application/json">${sv}</script></body></html>`;
}

/** Global fetch mock answering `body` on URLs matching `match`, 404 elsewhere. */
function stubFetch(match: RegExp, body: string) {
    const mock = vi.fn(async (input: string | URL) => (match.test(String(input)) ? new Response(body) : new Response('', { status: 404 })));
    vi.stubGlobal('fetch', mock);
    return mock;
}

/** Advance the fake clock past the retry backoffs, then settle `promise`. */
async function drain(promise: Promise<unknown>): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1000);
    }
    await promise;
}

function requestedUrls(mock: ReturnType<typeof stubFetch>): string[] {
    return mock.mock.calls.map(call => String(call[0]));
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('ComickConnector.getPages', () => {
    it('rebuilds the reader URL from a bare chapter hid (no chapter.url)', async () => {
        const mock = stubFetch(/\/comic\/x\//, readerHtml(['https://cdn1.comicknew.pictures/a/1.webp', 'https://cdn1.comicknew.pictures/a/2.webp']));
        const pages = await comick.getPages({ id: 'PhqcVk6n', title: 'REAL PLAY: BERSERKER' }, { id: HID, title: 'Ch.31 [ARVEN]' });
        expect(pages).toEqual(['https://cdn1.comicknew.pictures/a/1.webp', 'https://cdn1.comicknew.pictures/a/2.webp']);
        expect(requestedUrls(mock)).toEqual([`https://comick.art/comic/x/${HID}-chapter-x-en`]);
    });

    it('uses the stored chapter.url when present', async () => {
        const mock = stubFetch(/\/comic\//, readerHtml(['https://cdn1.comicknew.pictures/a/1.webp']));
        await comick.getPages({ id: 'm', title: 't' }, { id: HID, title: 'c', url: `https://comick.art/comic/01-level-berserker/${HID}-chapter-31-en` });
        expect(requestedUrls(mock)).toEqual([`https://comick.art/comic/01-level-berserker/${HID}-chapter-31-en`]);
    });

    it('reports missing pages as a SourceError, not a crash', async () => {
        stubFetch(/\/comic\//, `<!doctype html><html><body>${'y'.repeat(1100)}</body></html>`);
        await expect(comick.getPages({ id: 'm', title: 't' }, { id: HID, title: 'c' })).rejects.toThrow(SourceError);
    });
});

describe('ComickConnector.fetchPageImage', () => {
    it('retries 429s with backoff and succeeds once the CDN relents', async () => {
        vi.useFakeTimers();
        let hits = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                hits++;
                return hits <= 2
                    ? new Response('slow down', { status: 429 })
                    : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } });
            })
        );
        let result: { mime: string } | undefined;
        await drain(comick.fetchPageImage('https://cdn1.comicknew.pictures/a/17.webp').then(page => (result = page)));
        expect(hits).toBe(3);
        expect(result?.mime).toBe('image/webp');
    });

    it('gives up with a SourceError after the ladder is exhausted', async () => {
        vi.useFakeTimers();
        const mock = vi.fn(async () => new Response('slow down', { status: 429 }));
        vi.stubGlobal('fetch', mock);
        let error: unknown;
        await drain(comick.fetchPageImage('https://cdn1.comicknew.pictures/a/17.webp').catch(e => (error = e)));
        expect(error).toBeInstanceOf(SourceError);
        expect((error as Error).message).toContain('HTTP 429');
        expect(mock).toHaveBeenCalledTimes(4);
    });
});
