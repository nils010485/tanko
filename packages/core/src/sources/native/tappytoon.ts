/**
 * Native connector for Tappytoon (EN): anonymous device credentials are boot-
 * strapped from the __NEXT_DATA__ payload of the web discover page (Bearer
 * token + X-Device-Uuid), then used on the site API for series, chapters and
 * signed CDN page images (content-delivery). Only free/accessible chapters
 * work anonymously; adult "[Uncut]" titles throw InvalidLicense and are
 * filtered out of search results.
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

export interface TappytoonOptions {
    id?: string;
    label?: string;
    webBase?: string;
    apiBase?: string;
    locale?: string;
    tags?: string[];
}

interface TappytoonHeaders {
    Authorization?: string;
    'X-Device-Uuid'?: string;
}
interface TappytoonComic {
    id?: number;
    title?: string;
    slug?: string;
    thumbnailUrl?: string;
    /** "uncut" = adult edition requiring a licensed account (InvalidLicense). */
    contentRating?: string;
}

interface TappytoonChapter {
    id?: number;
    comicId?: number;
    title?: string;
    order?: number;
    isFree?: boolean;
    isAccessible?: boolean;
    isUserUnlocked?: boolean;
    isUserRented?: boolean;
}
interface TappytoonMedia {
    sortKey?: number;
    path?: string;
}

interface TappytoonContent {
    media?: TappytoonMedia[];
    contents?: Array<{ url?: string }>;
}

export class TappytoonConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly webBase: string;
    private readonly apiBase: string;
    private readonly locale: string;

    private headers: TappytoonHeaders | undefined;

    constructor(options: TappytoonOptions = {}) {
        this.id = options.id || 'tappytoon-en';
        this.label = options.label || 'Tappytoon';
        this.tags = options.tags || ['webtoon', 'english', 'manhwa', 'official'];
        this.webBase = (options.webBase || 'https://www.tappytoon.com').replace(/\/$/, '');
        this.apiBase = (options.apiBase || 'https://api-global.tappytoon.com').replace(/\/$/, '');
        this.locale = options.locale || 'en';
        this.url = `${this.webBase}/en/comics/discover`;
    }

    /** Extract an anonymous Bearer + device UUID from the Next.js payload. */
    private _parseHeaders(html: string): TappytoonHeaders | null {
        const document = parseDocument(html);
        const raw = document.querySelector('script#__NEXT_DATA__')?.textContent;
        if (!raw) {
            return null;
        }
        try {
            const parsed = JSON.parse(raw) as {
                props?: { initialState?: { axios?: { headers?: TappytoonHeaders } } };
            };
            const headers = parsed.props?.initialState?.axios?.headers;
            if (headers?.Authorization && headers?.['X-Device-Uuid']) {
                return { Authorization: headers.Authorization, 'X-Device-Uuid': headers['X-Device-Uuid'] };
            }
        } catch {
            /* malformed payload -> caller reports the failure */
        }
        return null;
    }

    async initialize(): Promise<void> {
        if (this.headers) {
            return;
        }
        try {
            const response = await fetch(this.url, {
                headers: { 'user-agent': randomUserAgent(), accept: 'text/html' },
                redirect: 'follow'
            });
            const html = await response.text().catch(() => '');
            const headers = response.ok ? this._parseHeaders(html) : null;
            if (!headers) {
                throw new SourceError(`__NEXT_DATA__ sans token device (HTTP ${response.status})`, this.id);
            }
            this.headers = headers;
        } catch (error) {
            if (error instanceof SourceError) {
                throw error;
            }
            throw new SourceError(`Initialisation échouée: ${errorMessage(error)}`, this.id, error);
        }
    }

    private async _getJson<T>(path: string): Promise<T> {
        await this.initialize();
        try {
            const response = await fetch(`${this.apiBase}${path}`, {
                headers: {
                    'user-agent': randomUserAgent(),
                    accept: 'application/json',
                    ...(this.headers || {})
                }
            });
            if (!response.ok) {
                const message = (await response.json().catch(() => null)) as { message?: string } | null;
                throw new SourceError(`API ${response.status}${message?.message ? `: ${message.message}` : ''} sur ${path}`, this.id);
            }
            return (await response.json()) as T;
        } catch (error) {
            if (error instanceof SourceError) {
                throw error;
            }
            throw new SourceError(`Requête API échouée: ${errorMessage(error)}`, this.id, error);
        }
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const data = await this._getJson<TappytoonComic[]>(`/comics?locale=${this.locale}`);
        const needle = query.trim().toLowerCase();
        return (
            (Array.isArray(data) ? data : [])
                // "uncut" (adult [Uncut] editions) always answer InvalidLicense anonymously
                .filter(comic => comic.contentRating !== 'uncut')
                .filter((comic): comic is TappytoonComic & { id: number; title: string } => !!comic.id && !!comic.title)
                .filter(comic => !needle || comic.title?.toLowerCase().includes(needle))
                .map(comic => ({
                    id: String(comic.id),
                    title: comic.title?.replace(/\s+/g, ' ').trim(),
                    url: `${this.webBase}/en/comics/${comic.slug || comic.id}`,
                    thumbnail: comic.thumbnailUrl || undefined
                }))
        );
    }

    /** Anonymous devices only reach free/unlocked chapters; the rest errors. */
    private _isReadable(chapter: TappytoonChapter): boolean {
        return !!(chapter.isAccessible && (chapter.isFree || chapter.isUserUnlocked || chapter.isUserRented));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const data = await this._getJson<TappytoonChapter[]>(`/comics/${manga.id}/chapters`);
        const chapters = (Array.isArray(data) ? data : [])
            .filter((chapter): chapter is TappytoonChapter & { id: number } => !!chapter.id && this._isReadable(chapter))
            .map(chapter => ({
                id: String(chapter.id),
                title: chapter.title || (chapter.order != null ? `Episode ${chapter.order}` : `Episode ${chapter.id}`),
                language: this.locale,
                url: `${this.webBase}/en/comics/${manga.id}/episodes/${chapter.id}`
            }));
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre accessible anonymement pour "${manga.title}" (titre payant ou [Uncut] ?)`, this.id);
        }
        // already oldest -> newest
        return chapters;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const data = await this._getJson<TappytoonContent>(`/content-delivery/contents?chapterId=${chapter.id}&variant=high&locale=${this.locale}`);
        const images = data.media
            ? data.media
                  .filter((item): item is TappytoonMedia & { path: string } => !!item.path)
                  .sort((a, b) => (a.sortKey || 0) - (b.sortKey || 0))
                  .map(item => item.path)
            : (data.contents || []).map(item => item.url).filter((url): url is string => !!url);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            await this.initialize();
            const data = await this._getJson<TappytoonComic[]>(`/comics?locale=${this.locale}`);
            if ((Array.isArray(data) ? data.length : 0) === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Catalogue vide' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
