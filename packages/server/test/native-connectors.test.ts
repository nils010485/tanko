/**
 * Native connector templates, parsing-only (global fetch stubbed with
 * fixture HTML — no network).
 */
import { MadaraConnector, MangastreamConnector } from '@tanko/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

function serve(pages: Record<string, string>) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = pages[url];
        return new Response(body ?? '', { status: body ? 200 : 404 });
    });
}

function pad(html: string): string {
    return html.replace('</body>', `<footer>${'lorem ipsum dolor sit amet '.repeat(60)}</footer></body>`);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('MangastreamConnector', () => {
    const listPage = `<html><body><div id="content"><div class="soralist"><ul>
        <li><a class="series" href="/series/alpha" title="Alpha">Alpha</a></li>
        <li><a class="series" href="/series/beta" title="Beta Manhwa">Beta Manhwa</a></li>
        </ul></div></div></body></html>`;
    const seriesPage = `<html><body><div id="chapterlist"><ul><li><div class="eph-num">
        <a href="/series/beta/chapter-3/"><span class="chapternum">Chapter 3</span></a>
        </div></li><li><div class="eph-num">
        <a href="/series/beta/chapter-2/"><span class="chapternum">Chapter 2</span></a>
        </div></li></ul></div></body></html>`;
    const chapterPage = `<html><body><script>window.ts_reader.run({"sources":[{"images":["/wp-content/img/b2-01.webp","/wp-content/img/b2-02.webp"]}]});</script>
        <div id="readerarea"><img src="/wp-content/img/b2-01.webp"></div></body></html>`;

    it('lists, filters, orders chapters chronologically and reads ts_reader images', async () => {
        vi.stubGlobal(
            'fetch',
            serve({
                'https://example.test/list/': pad(listPage),
                'https://example.test/series/beta': pad(seriesPage),
                'https://example.test/series/beta/chapter-3/': pad(chapterPage)
            })
        );
        const connector = new MangastreamConnector({ id: 'ms', label: 'MS', base: 'https://example.test' });
        const found = await connector.searchMangas('beta');
        expect(found.map(m => m.title)).toEqual(['Beta Manhwa']);
        expect(found[0].url).toBe('https://example.test/series/beta');

        const chapters = await connector.getChapters(found[0]);
        expect(chapters.map(c => c.title)).toEqual(['Chapter 2', 'Chapter 3']);

        const pages = await connector.getPages(found[0], chapters[1]);
        expect(pages).toEqual(['https://example.test/wp-content/img/b2-01.webp', 'https://example.test/wp-content/img/b2-02.webp']);
    });

    it('health reports an empty list as broken', async () => {
        vi.stubGlobal('fetch', serve({ 'https://example.test/list/': pad('<html><body>empty</body></html>') }));
        const connector = new MangastreamConnector({ id: 'ms', label: 'MS', base: 'https://example.test' });
        const health = await connector.checkHealth();
        expect(health.ok).toBe(false);
        expect(health.error).toContain('vide');
    });
});

describe('MadaraConnector paged-style fallback', () => {
    const pagedChapter = `<html><body>
        <div class="reading-content"><img class="wp-manga-chapter-img" src="/img/p001.png"></div>
        <a href="/manga/x/1/p/2/" class="btn next_page">Next</a>
        <select class="select_page"><option>Paged style</option></select>
        </body></html>`;
    const listChapter = `<html><body><div class="reading-content">
        <div class="page-break"><img src="/img/p001.png"></div>
        <div class="page-break"><img data-src="/img/p002.png"></div>
        <div class="page-break"><img data-src="/img/p003.png"></div>
        </div></body></html>`;

    it('collects all images via ?style=list when the pager is present', async () => {
        vi.stubGlobal(
            'fetch',
            serve({
                'https://example.test/manga/x/chapter-1/': pagedChapter,
                'https://example.test/manga/x/chapter-1/?style=list': listChapter
            })
        );
        const connector = new MadaraConnector({ id: 'md', label: 'MD', base: 'https://example.test' });
        const pages = await connector.getPages({ id: '/manga/x', title: 'X' }, { id: 'https://example.test/manga/x/chapter-1/', title: 'Chapter 1' });
        expect(pages).toHaveLength(3);
        expect(pages[2]).toBe('https://example.test/img/p003.png');
    });

    it('long-scroll chapters parse directly without the list round-trip', async () => {
        const fetchMock = serve({ 'https://example.test/manga/y/chapter-9/': listChapter });
        vi.stubGlobal('fetch', fetchMock);
        const connector = new MadaraConnector({ id: 'md', label: 'MD', base: 'https://example.test' });
        const pages = await connector.getPages({ id: '/manga/y', title: 'Y' }, { id: 'https://example.test/manga/y/chapter-9/', title: 'Chapter 9' });
        expect(pages).toHaveLength(3);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
