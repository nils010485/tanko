/**
 * Native connector for HentaiHand: the old HTML scraper is obsolete, the site
 * is now a Laravel app exposing a complete public JSON API (paginated catalog,
 * full-text search, comic details, chapter images on cdn.hentaihand.com).
 * Comic resolution requires the slug (linkcode/id 404s).
 */

import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

export interface HentaiHandOptions {
    id?: string;
    label?: string;
    base?: string;
    tags?: string[];
}

interface HentaiHandComic {
    id?: number;
    slug?: string;
    title?: string;
    cover_url?: string;
    image_url?: string;
    thumb_url?: string;
    md_covers?: Array<{ b2key?: string }>;
}

interface HentaiHandImage {
    page?: number;
    source_url?: string;
}

export class HentaiHandConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: HentaiHandOptions = {}) {
        this.id = options.id || 'hentaihand';
        this.label = options.label || 'HentaiHand';
        this.tags = options.tags || ['hentai', 'adult', 'english'];
        this.base = (options.base || 'https://hentaihand.com').replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private async _getJson<T>(url: string): Promise<T> {
        try {
            const response = await fetch(url, {
                headers: { 'user-agent': randomUserAgent(), accept: 'application/json' },
                redirect: 'follow'
            });
            if (!response.ok) {
                throw new SourceError(`HTTP ${response.status} on ${new URL(url).pathname}`, this.id);
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
        const data = await this._getJson<{ data?: HentaiHandComic[] }>(`${this.base}/api/comics?q=${encodeURIComponent(query.trim())}&page=1`);
        return (data.data || [])
            .filter((comic): comic is HentaiHandComic & { slug: string; title: string } => !!comic.slug && !!comic.title)
            .map(comic => ({
                id: comic.slug,
                title: comic.title?.replace(/\s+/g, ' ').trim(),
                url: `${this.base}/comics/${comic.slug}`,
                thumbnail: comic.thumb_url || comic.cover_url || comic.image_url || undefined
            }));
    }

    /** One-shot doujin site: a comic is its own single "chapter". */
    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const slug = manga.id.split('/').pop() || manga.id;
        const comic = await this._getJson<HentaiHandComic>(`${this.base}/api/comics/${slug}`);
        if (!comic.slug) {
            throw new SourceError(`Comic introuvable: ${slug} (slug requis, linkcode refusé)`, this.id);
        }
        return [
            {
                id: comic.slug,
                title: comic.title || manga.title,
                url: `${this.base}/comics/${comic.slug}`
            }
        ];
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const slug = chapter.id.split('/').pop() || chapter.id;
        const data = await this._getJson<{ images?: HentaiHandImage[] }>(`${this.base}/api/comics/${slug}/images`);
        const images = (data.images || [])
            .filter((image): image is HentaiHandImage & { source_url: string } => !!image.source_url)
            .sort((a, b) => (a.page || 0) - (b.page || 0))
            .map(image => image.source_url);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const response = await fetch(`${this.base}/api/comics?page=1`, {
                headers: { 'user-agent': randomUserAgent(), accept: 'application/json' }
            });
            if (!response.ok) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const body = (await response.json().catch(() => null)) as { total?: number } | null;
            if (!body?.total) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Catalogue vide (API modifiée ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
