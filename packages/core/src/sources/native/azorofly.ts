/**
 * Native connector for Azora Manga (https://azorafly.com, arabic/RTL): custom
 * Astro/VComics platform (report scripts/casework/azoraworld.md — the legacy
 * azoramoon.com domain redirects here; no Madara, no WordPress).
 *  - search : GET /api/query?searchTerm={q}&perPage={n}  (JSON)
 *  - chapters: full list inside the series page Astro island props
 *    (initialChap, Qwik-style [tag, payload] serialization); server-rendered
 *    a[href*="/chapter-"] anchors only cover the latest ~20 chapters
 *  - pages  : img[data-reader-page-image] (sorted by data-reader-index) on
 *    /series/{slug}/chapter-{n}, plain storage.azorafly.com CDN urls
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

interface AzoraPost {
    slug?: string;
    postTitle?: string;
    featuredImage?: string;
}

interface AzoraQueryResponse {
    posts?: AzoraPost[];
}

export class AzoraFlyConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'azoraworld';
    readonly label = 'Azora Manga';
    readonly tags = ['manga', 'manhwa', 'arabic'];
    readonly url = 'https://azorafly.com';

    private readonly base = 'https://azorafly.com';

    async initialize(): Promise<void> {}

    private _headers(): Record<string, string> {
        return {
            'user-agent': randomUserAgent(),
            accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'ar,en;q=0.5'
        };
    }

    private async _getText(url: string): Promise<string> {
        const response = await fetch(url, { headers: this._headers(), redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur ${new URL(url).pathname}`, this.id);
        }
        return response.text();
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        const url = `${this.base}/api/query?searchTerm=${encodeURIComponent(needle || 'a')}&perPage=100`;
        const response = await fetch(url, { headers: this._headers(), redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur /api/query`, this.id);
        }
        const json = (await response.json().catch(() => null)) as AzoraQueryResponse | null;
        if (!json || !Array.isArray(json.posts)) {
            throw new SourceError(`Réponse inattendue de l'API séries de ${this.label}`, this.id);
        }
        return json.posts
            .filter(post => !!post.slug)
            .map(post => ({
                id: post.slug as string,
                title: post.postTitle || (post.slug as string),
                url: `${this.base}/series/${post.slug}`,
                thumbnail: post.featuredImage,
                languages: ['ar']
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = manga.url || `${this.base}/series/${manga.id}`;
        const html = await this._getText(seriesUrl);
        const chapters = this._islandChapters(html, seriesUrl);
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }

    /** Full chapter list from the series page island props (initialChap);
     *  locked (coin-gated) chapters are skipped. */
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
                    const url = new URL(chapter.slug, `${seriesUrl}/`).href;
                    return { id: url, title: name ? `Chapter ${number} - ${name}` : `Chapter ${number}`, url, language: 'ar' };
                });
            if (chapters.length > 0) {
                return chapters.sort((a, b) => this._chapterNumber(a.url || a.id) - this._chapterNumber(b.url || b.id));
            }
        }
        return [];
    }

    /** Decode an island props attribute (HTML-escaped JSON) into plain values.
     *  Values are serialized as [tag, payload]: 0 = literal, 1 = array. */
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
        const images = [...document.querySelectorAll('img[data-reader-page-image]')]
            .map(img => ({ src: img.getAttribute('src'), index: Number(img.getAttribute('data-reader-index') || 0) }))
            .filter((entry): entry is { src: string; index: number } => !!entry.src && !entry.src.startsWith('data:'))
            .sort((a, b) => a.index - b.index)
            .map(entry => new URL(entry.src.trim(), chapterUrl).href);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const response = await fetch(`${this.base}/api/query?searchTerm=a&perPage=1`, {
                headers: this._headers(),
                signal: AbortSignal.timeout(15_000)
            });
            if (!response.ok) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const json = (await response.json().catch(() => null)) as AzoraQueryResponse | null;
            const ok = Array.isArray(json?.posts);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse API invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    private _chapterNumber(url: string): number {
        const match = /chapter-(\d+(?:\.\d+)?)/.exec(url);
        return match ? Number.parseFloat(match[1]) : Number.POSITIVE_INFINITY;
    }
}
