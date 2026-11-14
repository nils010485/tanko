/**
 * Tests for the MangaDex chapter-list language filter: `languages` in the
 * chapter options must reach the API as `translatedLanguage[]` params, and
 * its absence must keep the unfiltered (all languages) request - the
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
    const mock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } })
    );
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

    it('returns an empty list instead of failing when the title has no chapter', async () => {
        stubFetch(chapterList([]));
        await expect(new MangaDexConnector().getChapters(MANGA, { languages: ['en'] })).resolves.toEqual([]);
    });
});

describe('MangaDexConnector.searchMangas', () => {
    it('asks the API for titles that actually carry chapters', async () => {
        const mock = stubFetch({ result: 'ok', data: [], total: 0 });
        await new MangaDexConnector().searchMangas('solo level');
        const url = new URL(String(mock.mock.calls[0][0]));
        expect(url.searchParams.get('hasAvailableChapters')).toBe('true');
    });
});

describe('MangaDexConnector.searchMangas readable chapters', () => {
    const searchPayload = {
        result: 'ok',
        data: [
            { id: 'external-only', attributes: { title: { en: 'External Only' }, availableTranslatedLanguages: ['en'] } },
            { id: 'readable', attributes: { title: { en: 'Readable' }, availableTranslatedLanguages: ['en'] } }
        ]
    };

    function serveSearch(chapterTotals: Record<string, number>) {
        const mock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            const json = url.pathname === '/manga' ? searchPayload : { result: 'ok', data: [], total: chapterTotals[url.searchParams.get('manga') ?? ''] ?? 0 };
            return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } });
        });
        vi.stubGlobal('fetch', mock);
        return mock;
    }

    it('drops a title whose only chapters are hosted elsewhere', async () => {
        const mock = serveSearch({ 'external-only': 0, readable: 3 });
        const mangas = await new MangaDexConnector().searchMangas('x', { languages: ['en'] });
        expect(mangas.map(manga => manga.id)).toEqual(['readable']);
        const probe = new URL(String(mock.mock.calls[1]?.[0]));
        expect(probe.searchParams.get('includeExternalUrl')).toBe('0');
    });

    it('probes nothing when no language is requested', async () => {
        const mock = serveSearch({});
        const mangas = await new MangaDexConnector().searchMangas('x');
        expect(mangas).toHaveLength(2);
        expect(mock).toHaveBeenCalledTimes(1);
    });
});
