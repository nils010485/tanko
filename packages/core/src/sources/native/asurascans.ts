/**
 * Native connector for Asura Scans (asurascans.com), a popular English
 * scanlation site for manhwa/manga. The site is a statically generated
 * Astro app with a small JSON search API, so plain HTTP is enough (no
 * browser fallback needed).
 *
 * Not covered by the legacy Hakuneko connectors (they only know the old
 * `asuratoon.com` domain), hence a curated native connector.
 *
 * Endpoints relied upon:
 *  - search : GET https://api.asurascans.com/api/search?q={query}  (JSON)
 *  - chapters: server-rendered `a[href*="/chapter/"]` on the comic page
 *  - pages  : `img[data-page-index]` on the chapter page (absolute CDN urls)
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent, retryAfterMs } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const UA = randomUserAgent();

const BASE = 'https://asurascans.com';
const API = 'https://api.asurascans.com/api';

/** Item of the /api/search JSON response (only the fields we consume). */
interface AsuraSearchItem {
    title?: string;
    slug?: string;
    /** Path of the comic page on the main site, e.g. "/comics/<slug>-<code>". */
    public_url?: string;
    cover?: string;
}

/** Response of the /api/search endpoint. */
interface AsuraSearchResponse {
    data?: AsuraSearchItem[];
}

export class AsuraScansConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'asurascans';
    readonly label = 'Asura Scans';
    readonly tags = ['webtoon', 'english', 'manhwa'];
    readonly url = BASE;

    async initialize(): Promise<void> {
        // stateless: no session/cookie to warm up
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const json = (await this._getJson(`${API}/search?q=${encodeURIComponent(query)}`)) as AsuraSearchResponse | null;
        // the API answers {"data": null} for a query with no hit
        if (!json || (json.data !== null && json.data !== undefined && !Array.isArray(json.data))) {
            throw new SourceError(`Unexpected search response from ${this.label}`, this.id);
        }
        return (json.data ?? [])
            .filter((item): item is AsuraSearchItem & { public_url: string } => !!item.public_url)
            .map(item => ({
                id: item.public_url,
                title: item.title || item.slug || item.public_url,
                url: new URL(item.public_url, BASE).href,
                thumbnail: item.cover,
                languages: ['en']
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const mangaUrl = manga.url || new URL(manga.id, BASE).href;
        const html = await this._getText(mangaUrl);
        const document = parseDocument(html);

        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href*="/chapter/"]')]) {
            const href = anchor.getAttribute('href');
            if (!href) {
                continue;
            }
            const url = new URL(href, mangaUrl).href;
            // chapter rows: main label in span.font-medium, optional label in span.truncate;
            // "First/Last chapter" nav buttons have neither and fail the filter below
            const label = anchor.querySelector('span.font-medium');
            const text = ((label || anchor).textContent || '').replace(/\s+/g, ' ').trim();
            if (seen.has(url) || !/^chapter\s/i.test(text)) {
                continue;
            }
            seen.add(url);
            const suffix = (anchor.querySelector('span.truncate')?.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({
                id: url,
                title: suffix ? `${text} - ${suffix}` : text,
                url,
                language: 'en'
            });
        }

        // the page lists newest first -> order chronologically by chapter number
        chapters.sort((a, b) => this._chapterNumber(a.url || a.id) - this._chapterNumber(b.url || a.id) || a.title.localeCompare(b.title));
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        const document = parseDocument(html);

        // primary marker on chapter pages; fallback for older markup
        let images = this._imageSources(document, 'img[data-page-index]');
        if (images.length === 0) {
            images = this._imageSources(document, 'img[src*="/asura-images/chapters/"]');
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images.map(src => new URL(src.trim(), chapterUrl).href);
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const response = await fetch(`${API}/search?q=a`, {
                headers: this._headers(),
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const json = (await response.json().catch(() => null)) as AsuraSearchResponse | null;
            const ok = json !== null;
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse API invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    // ------------------------------------------------------------------
    /** Absolute image urls matching the selector (data: placeholders dropped). */
    private _imageSources(document: Document, selector: string): string[] {
        return [...document.querySelectorAll(selector)].map(img => img.getAttribute('src')).filter((src): src is string => !!src && !src.startsWith('data:'));
    }

    private _headers(): Record<string, string> {
        return {
            'User-Agent': UA,
            Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${BASE}/`
        };
    }

    private async _request(url: string, attempt = 0): Promise<Response> {
        let response: Response;
        try {
            response = await fetch(url, {
                headers: this._headers(),
                redirect: 'follow',
                signal: AbortSignal.timeout(60000)
            });
        } catch (error) {
            // network/timeout failure -> transient, retry with backoff
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 2500 * (attempt + 1)));
                return this._request(url, attempt + 1);
            }
            throw new SourceError(`GET ${url} failed after retries`, this.id, error);
        }
        // protection/rate-limit responses -> transient, honor Retry-After
        if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, retryAfterMs(response) ?? 2500 * (attempt + 1)));
            return this._request(url, attempt + 1);
        }
        if (!response.ok) {
            // permanent client errors (404, ...) -> fail fast, no retry
            throw new SourceError(`GET ${url} returned ${response.status}`, this.id);
        }
        return response;
    }

    private async _getText(url: string): Promise<string> {
        return (await this._request(url)).text();
    }

    private async _getJson(url: string): Promise<unknown> {
        return (await this._request(url)).json().catch(() => null);
    }

    private _chapterNumber(url: string): number {
        const match = /\/chapter\/(\d+(?:\.\d+)?)/.exec(url);
        return match ? Number.parseFloat(match[1]) : Number.POSITIVE_INFINITY;
    }
}
