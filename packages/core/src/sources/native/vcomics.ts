/**
 * Native connector for sites built on the "VComics" Astro framework
 * (HiveToons, ...): server-rendered series/chapter pages, a JSON search
 * endpoint and plain CDN page images, so plain HTTP is enough.
 *
 * The old domains of these sites (e.g. hivetoon.com) redirect to the new
 * ones and the legacy Hakuneko connectors still point at the old template,
 * hence curated native connectors.
 *
 * Endpoints relied upon:
 *  - search : GET {base}/api/query?searchTerm={q}&perPage={n}  (JSON)
 *  - chapters: server-rendered `a[href*="/chapter-"]` on the series page
 *  - pages  : `img[src*="/page-"]` on the chapter page (absolute CDN urls)
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { fetchWithRetries } from './http.js';

const UA = randomUserAgent();

/** Item of the /api/query JSON response (only the fields we consume). */
interface VComicsPost {
    slug?: string;
    postTitle?: string;
    featuredImage?: string;
}

/** Response of the /api/query endpoint. */
interface VComicsQueryResponse {
    posts?: VComicsPost[];
}

export interface VComicsOptions {
    id: string;
    label: string;
    base: string; // e.g. https://hivetoons.org
    tags?: string[];
    language?: string;
}

export class VComicsConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly language: string;

    constructor(options: VComicsOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['webtoon', 'english'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
        this.language = options.language || 'en';
    }

    async initialize(): Promise<void> {
        // stateless: no session/cookie to warm up
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = `${this.base}/api/query?searchTerm=${encodeURIComponent(query)}&perPage=25`;
        const json = (await this._getJson(url)) as VComicsQueryResponse | null;
        if (!json || !Array.isArray(json.posts)) {
            throw new SourceError(`Unexpected search response from ${this.label}`, this.id);
        }
        return json.posts
            .filter((post): post is VComicsPost & { slug: string } => !!post.slug)
            .map(post => ({
                id: post.slug,
                title: post.postTitle || post.slug,
                url: `${this.base}/series/${post.slug}`,
                thumbnail: post.featuredImage,
                languages: [this.language]
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = manga.url || `${this.base}/series/${manga.id}`;
        const html = await this._getText(seriesUrl);

        // the full list (all chapters incl. locked ones) is embedded in an
        // Astro island's serialized props; the server-rendered anchors only
        // cover the latest ~20 chapters and serve as fallback
        let chapters = this._islandChapters(html, seriesUrl);
        if (chapters.length === 0) {
            chapters = this._anchorChapters(html, seriesUrl);
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }

    /** Chapter rows of the series page: number in span.font-medium, optional
     *  title in the .line-clamp-1 row; the "Read Chapter N" CTA and dupes are
     *  dropped. Only the latest ~20 chapters are server-rendered. */
    private _anchorChapters(html: string, seriesUrl: string): ChapterInfo[] {
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href*="/chapter-"]')]) {
            const href = anchor.getAttribute('href');
            if (!href) {
                continue;
            }
            const url = new URL(href, seriesUrl).href;
            const text = ((anchor.querySelector('span.font-medium') || anchor).textContent || '').replace(/\s+/g, ' ').trim();
            if (seen.has(url) || !/^Chapter\s/.test(text)) {
                continue;
            }
            seen.add(url);
            const name = anchor.querySelector('.line-clamp-1')?.getAttribute('title')?.trim() || '';
            chapters.push({
                id: url,
                title: name ? `${text} - ${name}` : text,
                url,
                language: this.language
            });
        }
        return chapters.sort((a, b) => this._chapterNumber(a.url || a.id) - this._chapterNumber(b.url || b.id));
    }

    /** Full chapter list from the serialized props of the series-page island
     *  (initialChap). Locked (paid early-access) chapters are skipped. */
    private _islandChapters(html: string, seriesUrl: string): ChapterInfo[] {
        for (const match of html.matchAll(/<astro-island[^>]*\sprops="([^"]+)"/g)) {
            const props = this._parseProps(match[1]);
            const initial = props?.initialChap;
            if (!Array.isArray(initial)) {
                continue;
            }
            const chapters = initial
                .filter((chapter): chapter is Record<string, unknown> => !!chapter && typeof chapter === 'object' && !chapter.isLocked)
                .filter((chapter): chapter is Record<string, unknown> & { slug: string } => typeof chapter.slug === 'string')
                .map(chapter => {
                    const number = typeof chapter.number === 'number' ? chapter.number : this._chapterNumber(String(chapter.slug));
                    const name = typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : '';
                    return {
                        id: new URL(chapter.slug, `${seriesUrl}/`).href,
                        title: name ? `Chapter ${number} - ${name}` : `Chapter ${number}`,
                        url: new URL(chapter.slug, `${seriesUrl}/`).href,
                        language: this.language
                    };
                });
            if (chapters.length > 0) {
                return chapters.sort((a, b) => this._chapterNumber(a.url || a.id) - this._chapterNumber(b.url || b.id));
            }
        }
        return [];
    }

    /** Decode an island props attribute (HTML-escaped JSON) into plain values.
     *  Astro serializes every value as [tag, payload]: 0 = literal (possibly a
     *  composite whose fields are themselves tagged), 1 = array of tagged items. */
    private _parseProps(escaped: string): Record<string, unknown> | null {
        const unescaped = escaped
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
        try {
            const decoded = this._decodeValue(JSON.parse(unescaped));
            return decoded && typeof decoded === 'object' ? (decoded as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }

    private _decodeValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            const [tag, payload] = value;
            if (value.length === 2 && (tag === 0 || tag === 1)) {
                if (tag === 1 && Array.isArray(payload)) {
                    return payload.map(item => this._decodeValue(item));
                }
                return payload !== null && typeof payload === 'object' ? this._decodeValue(payload) : payload;
            }
            return value.map(item => this._decodeValue(item));
        }
        if (value !== null && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this._decodeValue(item)]));
        }
        return value;
    }
    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        const document = parseDocument(html);

        const images = [...document.querySelectorAll('img[src*="/page-"]')]
            .map(img => img.getAttribute('src'))
            .filter((src): src is string => !!src && !src.startsWith('data:'));
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images.map(src => new URL(src.trim(), chapterUrl).href);
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const response = await fetch(`${this.base}/api/query?searchTerm=a&perPage=1`, {
                headers: this._headers(),
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const json = (await response.json().catch(() => null)) as VComicsQueryResponse | null;
            const ok = Array.isArray(json?.posts);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse API invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    private _headers(): Record<string, string> {
        return {
            'User-Agent': UA,
            Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `${this.base}/`
        };
    }

    private _request(url: string): Promise<Response> {
        return fetchWithRetries(url, { id: this.id, headers: this._headers() });
    }

    private async _getText(url: string): Promise<string> {
        return (await this._request(url)).text();
    }

    private async _getJson(url: string): Promise<unknown> {
        return (await this._request(url)).json().catch(() => null);
    }

    private _chapterNumber(url: string): number {
        const match = /\/chapter-(\d+(?:\.\d+)?)/.exec(url);
        return match ? Number.parseFloat(match[1]) : Number.POSITIVE_INFINITY;
    }
}
