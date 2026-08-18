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
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError, errorMessage } from '../types.js';
import { randomUserAgent } from '../../shims/request.js';
import { parseDocument } from '../../shims/dom.js';

const UA = randomUserAgent();

export interface MadaraOptions {
    id: string;
    label: string;
    base: string;          // e.g. https://toonily.com
    tags?: string[];
}

export class MadaraConnector implements SourceAdapter {

    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly _ajaxHeaders: Record<string, string>;

    constructor(options: MadaraOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['webtoon'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
        this._ajaxHeaders = {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': this.base + '/'
        };
    }

    async initialize(): Promise<void> {
        // nothing to warm up; cookies are handled per request
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const body = new URLSearchParams({ action: 'wp-manga-search-manga', title: query });
        const response = await this._post(`${this.base}/wp-admin/admin-ajax.php`, body);
        const json = await response.json().catch(() => null);
        if (!json || json.success !== true || !Array.isArray(json.data)) {
            throw new SourceError(`Unexpected search response from ${this.label}`, this.id);
        }
        return json.data
            .filter((item: any) => item.url)
            .map((item: any) => ({
                id: this._mangaIdFromUrl(item.url),
                title: this._decode(item.label || item.title || item.value || item.url),
                url: item.url,
                thumbnail: item.thumbnail
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const mangaUrl = manga.url || this._mangaUrlFromId(manga.id);
        const html = await this._getText(mangaUrl);
        const document = parseDocument(html);

        let chapters = this._parseChapterNodes([...document.querySelectorAll('li.wp-manga-chapter')]);
        if (chapters.length === 0) {
            chapters = await this._getChaptersAjax(manga);
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        const document = parseDocument(html);

        const images = [...document.querySelectorAll('img.wp-manga-chapter-img')]
            .map((img: any) => img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src'))
            .filter((src: any) => src && !src.startsWith('data:'))
            .map((src: any) => new URL(src.trim(), chapterUrl).href)
            // drop site-injected ads/banners (e.g. Toonily discord assets)
            .filter((src: string) => !/\/wp-content\/assets\//i.test(src));

        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    // ------------------------------------------------------------------

    private _parseChapterNodes(nodes: any[]): ChapterInfo[] {
        const chapters: ChapterInfo[] = [];
        for (const node of nodes) {
            const anchor = node.querySelector('a');
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

    private async _getChaptersAjax(manga: MangaInfo): Promise<ChapterInfo[]> {
        try {
            const body = new URLSearchParams({ action: 'manga_get_chapters', manga: manga.id });
            const response = await this._post(`${this.base}/wp-admin/admin-ajax.php`, body);
            const json = await response.json().catch(() => null);
            if (json && Array.isArray(json.data)) {
                return json.data
                    .map((item: any) => ({
                        id: item.url,
                        title: item.title || item.name || '',
                        url: item.url
                    }))
                    .reverse();
            }
        } catch { /* fall through */ }
        return [];
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
        try {
            const response = await fetch(url, {
                ...init,
                redirect: 'follow',
                signal: AbortSignal.timeout(60000)
            });
            // transient protection/rate-limit responses -> retry with backoff
            if (response.status === 403 || response.status === 429 || response.status >= 500) {
                throw new SourceError(`HTTP ${response.status}`, this.id);
            }
            if (!response.ok) {
                throw new SourceError(`${init.method || 'GET'} ${url} returned ${response.status}`, this.id);
            }
            return response;
        } catch (error) {
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 2500 * (attempt + 1)));
                return this._request(url, init, attempt + 1);
            }
            throw new SourceError(`${init.method || 'GET'} ${url} failed after retries`, this.id, error);
        }
    }

    private async _getText(url: string): Promise<string> {
        const response = await this._request(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': this.base + '/'
            }
        });
        return response.text();
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
        try {
            // probe the real search ajax (raw fetch, no retry: health must fail fast)
            const body = new URLSearchParams({ action: 'wp-manga-search-manga', title: 'a' });
            const response = await fetch(`${this.base}/wp-admin/admin-ajax.php`, {
                method: 'POST',
                headers: this._ajaxHeaders,
                body: body.toString(),
                redirect: 'follow',
                signal: AbortSignal.timeout(20000)
            });
            if (!response.ok) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const json = await response.json().catch(() => null);
            const ok = json !== null && typeof json === 'object';
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse ajax invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
