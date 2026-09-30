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
import { absoluteUrl, checkHealthViaProbe, fetchRefererImage, noPagesError } from './http.js';

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
}

export class ComizyConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangabuddy';
    readonly label = 'MangaBuddy (comizy)';
    readonly tags = ['manga', 'english', 'manhwa'];
    private readonly apiBase = 'https://api.comizy.io';
    private readonly webBase = 'https://comizy.io';
    readonly url = this.webBase;

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

    private _splitMangaId(mangaId: string): string {
        return mangaId.split('#')[0];
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
        const id = this._splitMangaId(manga.id);
        const data = await this._getJson<{ chapters?: ComizyChapter[] }>(`${this.apiBase}/titles/${id}/chapters`);
        const chapters = (data.chapters || [])
            .filter((chapter): chapter is ComizyChapter & { id: string } => !!chapter.id)
            .map(chapter => ({
                id: chapter.id,
                title: chapter.name || (chapter.number != null ? `Chapter ${chapter.number}` : chapter.id),
                url: absoluteUrl(chapter.url, this.webBase) || `${this.webBase}/titles/${id}/${chapter.slug || chapter.id}`
            }));
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const data = await this._getJson<{ chapter?: ComizyChapterDetail }>(`${this.apiBase}/titles/${this._splitMangaId(manga.id)}/chapters/${chapter.id}`);
        const images = data.chapter?.images?.filter(src => typeof src === 'string' && src.startsWith('http')) || [];
        if (images.length === 0) {
            throw noPagesError(chapter, this);
        }
        return images;
    }

    /** cmzcdn.org rejects plain fetches without the site Referer (403). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        return fetchRefererImage(url, {
            id: this.id,
            referer: `${this.webBase}/`,
            error: (status, hostname) => `HTTP ${status} on ${hostname}`
        });
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaProbe(async () => {
            const data = await this._getJson<{ title?: ComizyTitle }>(`${this.apiBase}/titles/WjBr4oj2`);
            return { ok: !!data.title?.id, error: 'API répond mais sans titre attendu' };
        });
    }
}
