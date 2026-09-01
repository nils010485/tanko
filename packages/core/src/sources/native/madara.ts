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

import { browserEnabled, isAntiBotShell } from '../../shims/browser.js';
import { BROWSER_SESSION_MS, type BrowserResponse, browserCapturePageImages, browserFetch, browserFetchBinary } from '../../shims/browser-session.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent, retryAfterMs } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const UA = randomUserAgent();

/** What _request callers actually consume of a Response (fetch or browser). */
interface MinimalResponse {
    status: number;
    ok: boolean;
    headers: Headers;
    text(): Promise<string>;
}

/** Strip browser-forbidden headers (User-Agent, Referer): in-page fetch sends
 *  the browser's real UA and the page URL as Referer — exactly what the
 *  anti-bot expects — and overriding them would throw. */
function toPlainInit(init: RequestInit): { method?: string; headers?: Record<string, string>; body?: string } {
    const headers: Record<string, string> = {};
    const skip = new Set(['user-agent', 'referer']);
    new Headers(init.headers as HeadersInit | undefined).forEach((value, name) => {
        if (!skip.has(name.toLowerCase())) {
            headers[name] = value;
        }
    });
    return { method: init.method, headers, body: typeof init.body === 'string' ? init.body : undefined };
}

function wrapBrowserResponse(response: BrowserResponse): MinimalResponse {
    return {
        status: response.status,
        ok: response.ok,
        headers: new Headers(response.headers),
        text: () => Promise.resolve(response.body)
    };
}

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
    /** Reader decodes pages client-side (blob: images): capture the real
     *  image URLs during a browser render instead of parsing the HTML. */
    capturePages?: boolean;
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
    private readonly _capturePages: boolean;
    /** Sticky browser-mode deadline: 0 = raw HTTP; set when a challenge was
     *  proven, so later requests skip the doomed raw attempt. */
    private _browserUntil = 0;

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
        this._capturePages = options.capturePages === true;
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
            const json = (await response
                .text()
                .then(JSON.parse)
                .catch(() => null)) as { success?: boolean; data?: MadaraAjaxItem[] | Array<{ message?: string }> } | null;
            if (json !== null && typeof json === 'object') {
                // success:false with an empty/no data array ("no hit") ends here;
                // success:false with an error payload (e.g. "forbidden" on
                // locked-down ajax) must fall through to the HTML search page
                const errored = Array.isArray(json.data) && json.data.some(item => item && typeof item === 'object' && 'error' in item);
                if (!errored && (json.success !== true || !Array.isArray(json.data) || json.data.length === 0)) {
                    return [];
                }
                if (errored) {
                    // ajax locked down ("forbidden") -> HTML search page below
                } else {
                    return (json.data as MadaraAjaxItem[])
                        .filter((item): item is MadaraAjaxItem & { url: string } => !!item.url)
                        .map(item => ({
                            id: this._mangaIdFromUrl(item.url),
                            title: this._decode(item.label || item.title || item.value || item.url),
                            url: item.url,
                            thumbnail: item.thumbnail
                        }));
                }
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
        // themes disagree on the row markup (.c-tabs-item__content vs
        // .page-item-detail vs the a.acard cards)
        for (const row of [...document.querySelectorAll('.c-tabs-item__content, .page-item-detail, a.acard')]) {
            const asRow = row.tagName === 'A' ? row : null;
            // .post-title/.ac-t is manga-specific; the first link covers the rest
            const anchor = row.querySelector('.post-title a, .ac-t') || asRow || row.querySelector('a[href]');
            const href = (asRow ?? anchor)?.getAttribute('href');
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
        // client-side readers (blob: images): capture the real URLs mid-render
        if (this._capturePages) {
            const captured = await browserCapturePageImages(this.base, chapterUrl);
            if (captured.length === 0) {
                throw new SourceError(`No pages captured for "${chapter.title}" on ${this.label}`, this.id);
            }
            return captured;
        }
        const html = await this._getText(chapterUrl);
        const document = parseDocument(html);
        // paged-style reader (one image per page): the list style renders the
        // whole chapter at once — prefer it whenever the pager is present
        const paged = document.querySelector('.next_page[href], .select_page') !== null;
        let images = paged ? [] : this._pageImages(document, chapterUrl);
        if (images.length === 0 && paged) {
            const listUrl = new URL(chapterUrl);
            listUrl.searchParams.set('style', 'list');
            const listHtml = await this._getText(listUrl.href);
            images = this._pageImages(parseDocument(listHtml), listUrl.href);
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    private _pageImages(document: Document, baseUrl: string): string[] {
        for (const selector of this._pageSelectors) {
            const images = [...document.querySelectorAll(selector)]
                .map(img => img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src'))
                .filter((src): src is string => !!src && !src.startsWith('data:'))
                .map(src => new URL(src.trim(), baseUrl).href)
                // drop site-injected ads/banners (e.g. Toonily discord assets)
                .filter((src: string) => !/\/wp-content\/assets\//i.test(src));
            if (images.length > 0) {
                return images;
            }
        }
        return [];
    }

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

    private async _request(url: string, init: RequestInit, attempt = 0): Promise<MinimalResponse> {
        // sticky browser mode: a previously proven challenge skips the doomed raw attempt
        if (Date.now() < this._browserUntil) {
            return this._browserRequest(url, init);
        }
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
        if ((response.status === 403 || response.status === 503) && isAntiBotShell(await response.text().catch(() => ''), response.status)) {
            // proven anti-bot challenge -> escalate to the solved browser session
            if (!browserEnabled()) {
                throw new SourceError(`anti-bot: ${this.base} requires a browser (Cloudflare); no Chromium available`, this.id);
            }
            return this._browserRequest(url, init);
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

    /** Same request through the solved browser session (in-page fetch:
     *  cf_clearance cookies + Chrome's real TLS fingerprint, POST included). */
    private async _browserRequest(url: string, init: RequestInit): Promise<MinimalResponse> {
        const response = await browserFetch(this.base, url, toPlainInit(init)).catch((error: unknown) => {
            const message = errorMessage(error);
            // keep the classifiable 'anti-bot:' wording from the session layer
            throw new SourceError(
                message.startsWith('anti-bot') ? message : `${init.method || 'GET'} ${url} failed in browser session: ${message}`,
                this.id,
                error
            );
        });
        if (!response.ok) {
            throw new SourceError(`${init.method || 'GET'} ${url} returned ${response.status} (via browser)`, this.id);
        }
        // sticky browser mode only once the browser path proved itself
        this._browserUntil = Date.now() + BROWSER_SESSION_MS;
        return wrapBrowserResponse(response);
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
        return response
            .text()
            .then(JSON.parse)
            .catch(() => null);
    }

    private _post(url: string, body: URLSearchParams): Promise<MinimalResponse> {
        return this._request(url, {
            method: 'POST',
            headers: this._ajaxHeaders,
            body: body.toString()
        });
    }

    /** Page image through the source's own transport: hosts protected like the
     *  site itself block plain HTTP image GETs too (undici TLS fingerprint). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        const origin = new URL(url).origin;
        // only the site's own host shares the solved session: a foreign image
        // CDN would trigger a pointless 30s solve of a challenge it hasn't got
        if (Date.now() >= this._browserUntil || origin !== this.base) {
            throw new Error('not in browser mode'); // caller falls back to raw fetch
        }
        const response = await browserFetchBinary(origin, url);
        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}`);
        }
        return { mime: response.mime, data: response.data };
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        // 1) fail-fast raw probes: the search ajax, then the search page
        const { result: raw, antibot } = await this._probeRaw(startedAt);
        if (raw.ok) {
            this._browserUntil = 0; // the site answers plain HTTP again
            return { ...raw, via: 'http' };
        }
        if (!antibot) {
            return raw; // dead/5xx/timeout: report as-is
        }
        // 2) proven anti-bot challenge -> escalate through the browser
        if (!browserEnabled()) {
            return { ...raw, error: 'anti-bot: Cloudflare challenge; no browser backend (needs Chromium + Xvfb — the Docker image has both)' };
        }
        try {
            const response = await browserFetch(this.base, `${this.base}/?s=a&post_type=wp-manga`);
            const ok = response.ok && !isAntiBotShell(response.body, response.status);
            if (ok) {
                // warm the sticky browser mode for real traffic
                this._browserUntil = Date.now() + BROWSER_SESSION_MS;
            }
            return {
                ok,
                latencyMs: Date.now() - startedAt,
                via: ok ? 'browser' : undefined,
                error: ok ? undefined : 'anti-bot: Cloudflare challenge not solved (browser present but blocked)'
            };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    /** Raw fail-fast probes (no browser): the search ajax, then the server-rendered
     *  search page (NoAjax Madara sites disable admin-ajax). */
    private async _probeRaw(startedAt: number): Promise<{ result: HealthResult; antibot: boolean }> {
        const ajax = await fetch(`${this.base}/wp-admin/admin-ajax.php`, {
            method: 'POST',
            headers: this._ajaxHeaders,
            body: new URLSearchParams({ action: 'wp-manga-search-manga', title: 'a' }).toString(),
            redirect: 'follow',
            signal: AbortSignal.timeout(20000)
        }).catch(() => undefined);
        if (ajax?.ok) {
            const json: unknown = await ajax.json().catch(() => null);
            if (json !== null && typeof json === 'object') {
                return { result: { ok: true, latencyMs: Date.now() - startedAt }, antibot: false };
            }
            // 200 with a non-JSON body (old-WP "0"): fall through to the page probe
        } else if (ajax && (ajax.status === 403 || ajax.status === 503) && isAntiBotShell(await ajax.text().catch(() => ''), ajax.status)) {
            return { result: { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${ajax.status}` }, antibot: true };
        }
        try {
            const page = await fetch(`${this.base}/?s=a&post_type=wp-manga`, {
                headers: { 'User-Agent': UA, Referer: `${this.base}/` },
                redirect: 'follow',
                signal: AbortSignal.timeout(20000)
            });
            const html = await page.text().catch(() => '');
            // a WAF challenge served with HTTP 200 must not count as healthy
            const antibot = isAntiBotShell(html, page.status);
            // a redirect landing on another origin means the site is gone
            // (Discord invite, parked domain, rebranded spam) — not healthy
            const sameSite = new URL(page.url).hostname === new URL(this.base).hostname;
            const ok = page.ok && !antibot && sameSite;
            return {
                result: {
                    ok,
                    latencyMs: Date.now() - startedAt,
                    error: ok ? undefined : sameSite ? `HTTP ${page.status}` : 'Site déménagé (redirection externe)'
                },
                antibot
            };
        } catch (error) {
            return { result: { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) }, antibot: false };
        }
    }
}
