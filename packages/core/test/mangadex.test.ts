/**
 * Tests for the MangaDex chapter-list language filter: `languages` in the
 * chapter options must reach the API as `translatedLanguage[]` params, and
 * its absence must keep the unfiltered (all languages) request — the
 * server-side `chapterAllowed` filter stays the correctness mechanism.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MangaDexConnector } from '../src/sources/native/mangadex.js';

const MANGA = { id: 'f9c33607-9180-4ba6-b85c-e4b5faee7192', title: 'Berserk' };

function chapterList(languages: string[]) {
    return {
        result: 'ok',
        data: languages.map((language, i) => ({
            id: `ch-${i}`,
            attributes: { chapter: String(i + 1), translatedLanguage: language, title: null }
        })),
        total: languages.length
    };
}

function stubFetch(json: unknown) {
    const mock = vi.fn(async () => new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', mock);
    return mock;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('MangaDexConnector.getChapters language filter', () => {
    it('appends one translatedLanguage[] param per preferred language', async () => {
        const mock = stubFetch(chapterList(['en', 'en']));
        const chapters = await new MangaDexConnector().getChapters(MANGA, { languages: ['en', 'fr'] });
        const url = new URL(String(mock.mock.calls[0][0]));
        expect(url.searchParams.getAll('translatedLanguage[]')).toEqual(['en', 'fr']);
        expect(chapters.map(chapter => chapter.language)).toEqual(['en', 'en']);
    });

    it('expands regional variants so the fetch matches the 2-letter downstream filter', async () => {
        const mock = stubFetch(chapterList(['pt-br']));
        await new MangaDexConnector().getChapters(MANGA, { languages: ['pt'] });
        const url = new URL(String(mock.mock.calls[0][0]));
        expect(url.searchParams.getAll('translatedLanguage[]')).toEqual(['pt', 'pt-br']);

        const es = stubFetch(chapterList(['es-la']));
        await new MangaDexConnector().getChapters(MANGA, { languages: ['es'] });
        expect(new URL(String(es.mock.calls[0][0])).searchParams.getAll('translatedLanguage[]')).toEqual(['es', 'es-la']);
    });

    it('sends no language filter when the option is omitted', async () => {
        const mock = stubFetch(chapterList(['ja', 'en']));
        await new MangaDexConnector().getChapters(MANGA);
        const url = new URL(String(mock.mock.calls[0][0]));
        expect(url.searchParams.has('translatedLanguage[]')).toBe(false);
    });

    it('sends no language filter for an empty list', async () => {
        const mock = stubFetch(chapterList(['ja']));
        await new MangaDexConnector().getChapters(MANGA, { languages: [] });
        const url = new URL(String(mock.mock.calls[0][0]));
        expect(url.searchParams.has('translatedLanguage[]')).toBe(false);
    });
});
