/**
 * Native connector for sites using the WordPress "Madara" theme, a very
 * common template for manhwa/manga sites (Toonily, ManhwaTop, ...).
 *
 * Endpoints relied upon:
 *  - search : POST {base}/wp-admin/admin-ajax.php  (action=wp-manga-search-manga)
 *  - chapters: server-rendered `li.wp-manga-chapter` on the manga page,
 *              with an ajax fallback (action=manga_get_chapters)
 *  - pages  : `img.wp-manga-chapter-img` on the chapter page
 */

import { isAntiBotShell } from '../../shims/browser.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent, retryAfterMs } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const UA = randomUserAgent();

/** Madara ajax search/ajax-chapter item (wp-manga-search-manga, manga_get_chapters). */
interface MadaraAjaxItem {
    url?: string;
    label?: string;
    title?: string;
    name?: string;
    value?: string;
    thumbnail?: string;
}

/** Row of a JSON chapter API response (kunmanga-style themes). */
interface ApiChapter {
    chapter_slug: string;
    chapter_name?: string;
}

function isApiChapter(item: unknown): item is ApiChapter {
    return !!item && typeof item === 'object' && typeof (item as { chapter_slug?: unknown }).chapter_slug === 'string';
}

export interface MadaraOptions {
    id: string;
    label: string;
    base: string; // e.g. https://toonily.com
    tags?: string[];
    /** JSON chapter API prefix (e.g. "/api/comics") for themes whose manga
     *  page loads the chapter list client-side: GET {base}{prefix}/{slug}/chapters. */
    chapterApiPath?: string;
    /** Site-specific overrides for themes that renamed the Madara classes. */
    selectors?: {
        /** Chapter list rows (default: li.wp-manga-chapter). */
        chapters?: string;
        /** Link inside a row; '' = the row itself is the link (default: a). */
        chapterAnchor?: string;
        /** Page images (default: img.wp-manga-chapter-img, div.page-break img). */
        pages?: string;
    };
}

export class MadaraConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly _ajaxHeaders: Record<string, string>;
    private readonly _chapterSelector: string;
    private readonly _chapterAnchorSelector: string | null;
    private readonly _pageSelectors: string[];
    private readonly _chapterApiPath?: string;

    constructor(options: MadaraOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['webtoon'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
        this._chapterSelector = options.selectors?.chapters || 'li.wp-manga-chapter';
        // '' in chapterAnchor means the chapter row itself is the link -> null
        const anchorSelector = options.selectors?.chapterAnchor;
        this._chapterAnchorSelector = anchorSelector === undefined ? 'a' : anchorSelector || null;
        this._pageSelectors = [options.selectors?.pages || 'img.wp-manga-chapter-img', 'div.page-break img'];
        this._chapterApiPath = options.chapterApiPath;
        this._ajaxHeaders = {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${this.base}/`
        };
    }

    async initialize(): Promise<void> {
        // nothing to warm up; cookies are handled per request
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        // preferred: the ajax endpoint; "NoAjax" Madara sites disable it (404)
        // and fall back to the server-rendered search page
        try {
            const body = new URLSearchParams({ action: 'wp-manga-search-manga', title: query });
            const response = await this._post(`${this.base}/wp-admin/admin-ajax.php`, body);
            const json = (await response.json().catch(() => null)) as { success?: boolean; data?: MadaraAjaxItem[] | Array<{ message?: string }> } | null;
            if (json !== null && typeof json === 'object') {
                // the endpoint answered: success:false with a message row, or an
                // empty data array, both mean "no hit" -> not an error
                if (json.success !== true || !Array.isArray(json.data) || json.data.length === 0) {
                    return [];
                }
                return (json.data as MadaraAjaxItem[])
                    .filter((item): item is MadaraAjaxItem & { url: string } => !!item.url)
                    .map(item => ({
                        id: this._mangaIdFromUrl(item.url),
                        title: this._decode(item.label || item.title || item.value || item.url),
                        url: item.url,
                        thumbnail: item.thumbnail
                    }));
            }
        } catch {
            /* fall through to the HTML search page */
        }
        return this._searchHtml(query);
    }

    /** Server-rendered search: /?s={q}&post_type=wp-manga rows (NoAjax sites). */
    private async _searchHtml(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}/?s=${encodeURIComponent(query)}&post_type=wp-manga`);
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        // themes disagree on the row markup (.c-tabs-item__content vs .page-item-detail)
        for (const row of [...document.querySelectorAll('.c-tabs-item__content, .page-item-detail')]) {
            // .post-title is manga-specific; the first link covers themes without it
            const anchor = row.querySelector('.post-title a') || row.querySelector('a[href]');
            const href = anchor?.getAttribute('href');
            if (!anchor || !href) {
                continue;
            }
            const img = row.querySelector('img');
            const thumbnail = img?.getAttribute('data-src') || img?.getAttribute('data-backup') || img?.getAttribute('src') || undefined;
            results.push({
                id: this._mangaIdFromUrl(href),
                title: this._decode((anchor.textContent || '').replace(/\s+/g, ' ').trim()),
                url: new URL(href, this.base).href,
                thumbnail: thumbnail && !thumbnail.startsWith('data:') ? thumbnail : undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        let chapters: ChapterInfo[] = [];
        // JSON chapter API (themes that load the list client-side)
        if (this._chapterApiPath) {
            chapters = await this._getChaptersApi(manga);
        }
        if (chapters.length === 0) {
            const mangaUrl = manga.url || this._mangaUrlFromId(manga.id);
            const html = await this._getText(mangaUrl);
            const document = parseDocument(html);
            chapters = this._parseChapterNodes([...document.querySelectorAll(this._chapterSelector)]);
            if (chapters.length === 0) {
                chapters = await this._getChaptersAjax(mangaUrl, document);
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }

    /** Lazy-loaded chapter lists: modern Madara answers POST {mangaUrl}ajax/chapters/,
     *  older themes want admin-ajax action=manga_get_chapters with the numeric
     *  post id found in the #manga-chapters-holder[data-id] placeholder. */
    private async _getChaptersAjax(mangaUrl: string, document: Document): Promise<ChapterInfo[]> {
        try {
            const response = await this._post(`${mangaUrl.replace(/\/?$/, '/')}ajax/chapters/`, new URLSearchParams());
            const chapters = this._parseChapterNodes([...parseDocument(await response.text()).querySelectorAll(this._chapterSelector)]);
            if (chapters.length > 0) {
                return chapters;
            }
        } catch {
            /* try the legacy action below */
        }
        const postId = document.querySelector('[id^="manga-chapters-holder"]')?.getAttribute('data-id');
        if (!postId) {
            return [];
        }
        try {
            const body = new URLSearchParams({ action: 'manga_get_chapters', manga: postId });
            const response = await this._post(`${this.base}/wp-admin/admin-ajax.php`, body);
            return this._parseChapterNodes([...parseDocument(await response.text()).querySelectorAll(this._chapterSelector)]);
        } catch {
            return [];
        }
    }

    /** JSON chapter list: GET {base}{apiPath}/{slug}/chapters (paginated, newest first). */
    private static readonly MAX_CHAPTER_API_PAGES = 50; // 50 x 100 = hard cap of 5000 chapters

    private async _getChaptersApi(manga: MangaInfo): Promise<ChapterInfo[]> {
        const segments = manga.id.replace(/^\/+|\/+$/g, '').split('/');
        const slug = segments.pop() || manga.id;
        // chapter urls reuse the manga path prefix (/manga/, /series/, ...)
        const pathPrefix = `/${segments[0] || 'manga'}`;
        const urlFor = (page: number) => `${this.base}${this._chapterApiPath}/${slug}/chapters?per_page=100&page=${page}`;
        const first = await this._chapterApiPage(urlFor(1), slug, pathPrefix);
        if (first.items.length === 0) {
            return [];
        }
        const chapters = first.items;
        for (let page = 2; page <= Math.min(first.lastPage, MadaraConnector.MAX_CHAPTER_API_PAGES); page++) {
            chapters.push(...(await this._chapterApiPage(urlFor(page), slug, pathPrefix)).items);
        }
        return chapters.reverse();
    }

    /** One page of the JSON chapter API: chapter rows + pagination metadata. */
    private async _chapterApiPage(url: string, slug: string, pathPrefix: string): Promise<{ items: ChapterInfo[]; lastPage: number }> {
        const json = (await this._getJson(url)) as { data?: { chapters?: unknown[]; last_page?: number } } | null;
        const payload = json?.data;
        if (!Array.isArray(payload?.chapters)) {
            return { items: [], lastPage: 1 };
        }
        const items = (payload.chapters as unknown[]).filter(isApiChapter).map(item => {
            const chapterUrl = new URL(`${pathPrefix}/${slug}/${item.chapter_slug}`, this.base).href;
            return { id: chapterUrl, title: item.chapter_name || item.chapter_slug, url: chapterUrl };
        });
        return { items, lastPage: typeof payload.last_page === 'number' ? payload.last_page : 1 };
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        const document = parseDocument(html);

        let images: string[] = [];
        for (const selector of this._pageSelectors) {
            images = [...document.querySelectorAll(selector)]
                .map(img => img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src'))
                .filter((src): src is string => !!src && !src.startsWith('data:'))
                .map(src => new URL(src.trim(), chapterUrl).href)
                // drop site-injected ads/banners (e.g. Toonily discord assets)
                .filter((src: string) => !/\/wp-content\/assets\//i.test(src));
            if (images.length > 0) {
                break;
            }
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    // ------------------------------------------------------------------

    private _parseChapterNodes(nodes: Element[]): ChapterInfo[] {
        const chapters: ChapterInfo[] = [];
        for (const node of nodes) {
            // '' in options.chapterAnchor = the row itself is the link
            const anchor = this._chapterAnchorSelector === null ? node : node.querySelector(this._chapterAnchorSelector || 'a');
            if (!anchor) {
                continue;
            }
            const href = anchor.getAttribute('href');
            if (!href) {
                continue;
            }
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({ id: href, title, url: href });
        }
        // Madara lists newest first -> reverse to chronological order
        return chapters.reverse();
    }

    private _mangaIdFromUrl(url: string): string {
        try {
            const parsed = new URL(url);
            return parsed.pathname.replace(/\/$/, '') || url;
        } catch {
            return url;
        }
    }

    private _mangaUrlFromId(id: string): string {
        if (id.startsWith('http')) {
            return id;
        }
        return this.base + id;
    }

    private _decode(text: string): string {
        return String(text)
            .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
            .replace(/&amp;/g, '&');
    }

    private async _request(url: string, init: RequestInit, attempt = 0): Promise<Response> {
        let response: Response;
        try {
            response = await fetch(url, {
                ...init,
                redirect: 'follow',
                signal: AbortSignal.timeout(60000)
            });
        } catch (error) {
            // network/timeout failure -> transient, retry with backoff
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 2500 * (attempt + 1)));
                return this._request(url, init, attempt + 1);
            }
            throw new SourceError(`${init.method || 'GET'} ${url} failed after retries`, this.id, error);
        }
        // protection/rate-limit responses -> transient, honor Retry-After
        if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, retryAfterMs(response) ?? 2500 * (attempt + 1)));
            return this._request(url, init, attempt + 1);
        }
        if (!response.ok) {
            // permanent client errors (404, ...) -> fail fast, no retry
            throw new SourceError(`${init.method || 'GET'} ${url} returned ${response.status}`, this.id);
        }
        return response;
    }

    private async _getText(url: string): Promise<string> {
        const response = await this._request(url, {
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                Referer: `${this.base}/`
            }
        });
        return response.text();
    }

    private async _getJson(url: string): Promise<unknown> {
        const response = await this._request(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${this.base}/` }
        });
        return response.json().catch(() => null);
    }

    private _post(url: string, body: URLSearchParams): Promise<Response> {
        return this._request(url, {
            method: 'POST',
            headers: this._ajaxHeaders,
            body: body.toString()
        });
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        // probe the real search ajax (raw fetch, no retry: health must fail fast)
        const body = new URLSearchParams({ action: 'wp-manga-search-manga', title: 'a' });
        const response = await fetch(`${this.base}/wp-admin/admin-ajax.php`, {
            method: 'POST',
            headers: this._ajaxHeaders,
            body: body.toString(),
            redirect: 'follow',
            signal: AbortSignal.timeout(20000)
        }).catch(() => undefined);
        if (response?.ok) {
            const json: unknown = await response.json().catch(() => null);
            if (json !== null && typeof json === 'object') {
                return { ok: true, latencyMs: Date.now() - startedAt };
            }
            // 200 with a non-JSON body (old-WP "0"): fall through to the page probe
        }
        // NoAjax Madara sites disable admin-ajax -> the search page is the probe
        try {
            const page = await fetch(`${this.base}/?s=a&post_type=wp-manga`, {
                headers: { 'User-Agent': UA, Referer: `${this.base}/` },
                redirect: 'follow',
                signal: AbortSignal.timeout(20000)
            });
            const html = await page.text().catch(() => '');
            // a WAF challenge served with HTTP 200 must not count as healthy
            const ok = page.ok && !isAntiBotShell(html);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : `HTTP ${page.status}` };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
