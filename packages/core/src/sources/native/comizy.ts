/**
 * Native connector for MangaBuddy, rebranded as comizy.io (2026). The legacy
 * MadTheme stack is gone: the site is now a Next.js front-end backed by a
 * public JSON API at https://api.comizy.io (search / title / chapters /
 * chapter images). Images are served from x2-x9.cmzcdn.org and require the
 * Referer header (plain HTTP gets 403), hence fetchPageImage.
 */

import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { absoluteUrl } from './http.js';

export interface ComizyOptions {
    id?: string;
    label?: string;
    apiBase?: string;
    webBase?: string;
    tags?: string[];
}

interface ComizySearchItem {
    id?: string;
    name?: string;
    slug?: string;
    cover?: string;
}

interface ComizyTitle {
    id?: string;
    name?: string;
    url?: string;
    cover?: string;
    stats?: { chapters_count?: number };
}

interface ComizyChapter {
    id?: string;
    name?: string;
    slug?: string;
    number?: number;
    url?: string;
}

interface ComizyChapterDetail {
    images?: string[];
    pages?: Array<{ url?: string; image?: string }>;
}

export class ComizyConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly apiBase: string;
    private readonly webBase: string;

    constructor(options: ComizyOptions = {}) {
        this.id = options.id || 'mangabuddy';
        this.label = options.label || 'MangaBuddy (comizy)';
        this.tags = options.tags || ['manga', 'english', 'manhwa'];
        this.apiBase = (options.apiBase || 'https://api.comizy.io').replace(/\/$/, '');
        this.webBase = (options.webBase || 'https://comizy.io').replace(/\/$/, '');
        this.url = this.webBase;
    }

    async initialize(): Promise<void> {}

    private async _getJson<T>(url: string): Promise<T> {
        try {
            const response = await fetch(url, {
                headers: { 'user-agent': randomUserAgent(), accept: 'application/json' },
                redirect: 'follow'
            });
            const body = (await response.json().catch(() => null)) as { success?: boolean; data?: T; message?: string } | null;
            if (!response.ok || !body || body.success === false) {
                throw new SourceError(`API ${response.status}${body?.message ? `: ${body.message}` : ''} on ${new URL(url).hostname}`, this.id);
            }
            return (body.data ?? body) as T;
        } catch (error) {
            if (error instanceof SourceError) {
                throw error;
            }
            throw new SourceError(`Requête API échouée: ${errorMessage(error)}`, this.id, error);
        }
    }

    /** MangaInfo.id carries the API sqid; the slug rides along for web URLs. */
    private _mangaId(id: string, slug?: string): string {
        return slug ? `${id}#${slug}` : id;
    }

    private _splitMangaId(manga: MangaInfo): string {
        return manga.id.split('#')[0];
    }
    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.webBase);
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const data = await this._getJson<{ items?: ComizySearchItem[] }>(`${this.apiBase}/titles/search?q=${encodeURIComponent(query.trim())}`);
        return (data.items || [])
            .filter((item): item is ComizySearchItem & { id: string; name: string } => !!item.id && !!item.name)
            .map(item => ({
                id: this._mangaId(item.id, item.slug),
                title: item.name?.replace(/\s+/g, ' ').trim(),
                url: `${this.webBase}/titles/${item.id}`,
                thumbnail: item.cover || undefined
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const id = this._splitMangaId(manga);
        const data = await this._getJson<{ chapters?: ComizyChapter[] }>(`${this.apiBase}/titles/${id}/chapters`);
        const chapters = (data.chapters || [])
            .filter((chapter): chapter is ComizyChapter & { id: string } => !!chapter.id)
            .map(chapter => ({
                id: chapter.id,
                title: chapter.name || (chapter.number != null ? `Chapter ${chapter.number}` : chapter.id),
                url: this._absolute(chapter.url) || `${this.webBase}/titles/${id}/${chapter.slug || chapter.id}`
            }));
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const data = await this._getJson<{ chapter?: ComizyChapterDetail }>(`${this.apiBase}/titles/${this._splitMangaId(_manga)}/chapters/${chapter.id}`);
        const images = data.chapter?.images?.filter(src => typeof src === 'string' && src.startsWith('http')) || [];
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    /** cmzcdn.org rejects plain fetches without the site Referer (403). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), referer: `${this.webBase}/`, accept: 'image/*' }
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, this.id);
        }
        const buffer = await response.arrayBuffer();
        return { mime: response.headers.get('content-type') || 'image/webp', data: new Uint8Array(buffer) };
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const data = await this._getJson<{ title?: ComizyTitle }>(`${this.apiBase}/titles/WjBr4oj2`);
            if (!data.title?.id) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'API répond mais sans titre attendu' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
