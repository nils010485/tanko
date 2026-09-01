/**
 * Native connector for Assorted Scans (https://assortedscans.com), formerly
 * Helvetica Scans (report scripts/casework/helveticascans.md — the site left
 * FoolSlide for a MangAdventure v0.9.6 install).
 *
 * MangAdventure JSON API v2 (beware: a trailing slash on the series list
 * endpoint returns HTTP 501 "Invalid API endpoint"):
 *  - search : GET /api/v2/series?title={q}  (+ ?page=N, 25 per page)
 *  - chapters: GET /api/v2/series/{slug}/chapters
 *  - pages  : GET /api/v2/chapters/{id}/pages  (absolute CDN urls, i3.wp.com)
 */

import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

interface MaSeries {
    slug: string;
    title: string;
    cover?: string;
    chapters?: number;
}

interface MaSeriesResponse {
    total?: number;
    last?: boolean;
    results?: MaSeries[];
}

interface MaChapter {
    id: number;
    title?: string | null;
    full_title?: string | null;
    number?: number;
}

interface MaChaptersResponse {
    results?: MaChapter[];
}

interface MaPage {
    image?: string;
}

interface MaPagesResponse {
    results?: MaPage[];
}

export class AssortedScansConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'helveticascans';
    readonly label = 'Assorted Scans (ex-Helvetica)';
    readonly tags = ['manga', 'english'];
    readonly url = 'https://assortedscans.com';

    private readonly base = 'https://assortedscans.com';

    async initialize(): Promise<void> {}

    private async _getJson(url: string): Promise<unknown> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'application/json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur ${new URL(url).pathname}`, this.id);
        }
        return response.json().catch(() => null);
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        // server-side title filter when given; otherwise walk all pages
        // (/api/v2/series without trailing slash, else HTTP 501)
        const results: MaSeries[] = [];
        if (needle) {
            const json = (await this._getJson(`${this.base}/api/v2/series?title=${encodeURIComponent(needle)}`)) as MaSeriesResponse | null;
            results.push(...(json?.results ?? []));
        } else {
            for (let page = 1; page <= 20; page++) {
                const json = (await this._getJson(`${this.base}/api/v2/series?page=${page}`)) as MaSeriesResponse | null;
                results.push(...(json?.results ?? []));
                if (json?.last !== false || !json.results?.length) {
                    break;
                }
            }
        }
        if (results.length === 0 && needle) {
            return [];
        }
        return results
            .filter(series => !!series.slug && !!series.title)
            .map(series => ({
                id: series.slug,
                title: series.title,
                url: `${this.base}/reader/${series.slug}/`,
                thumbnail: series.cover,
                languages: ['en']
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const slug = manga.id || (manga.url || '').replace(/.*\/reader\//, '').replace(/\/$/, '');
        const json = (await this._getJson(`${this.base}/api/v2/series/${slug}/chapters`)) as MaChaptersResponse | null;
        const chapters = json?.results;
        if (!Array.isArray(chapters) || chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        // API lists chapters newest first -> chronological
        return chapters
            .slice()
            .reverse()
            .map(chapter => ({
                id: String(chapter.id),
                title: chapter.full_title?.trim() || chapter.title?.trim() || `Chapter ${chapter.number ?? chapter.id}`,
                url: `${this.base}/api/v2/chapters/${chapter.id}/pages`,
                language: 'en'
            }));
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const endpoint = (chapter.url || chapter.id).includes('/api/v2/chapters/')
            ? chapter.url || chapter.id
            : `${this.base}/api/v2/chapters/${chapter.id}/pages`;
        const json = (await this._getJson(endpoint)) as MaPagesResponse | null;
        const images = (json?.results || []).map(page => page.image).filter((image): image is string => !!image);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const json = (await this._getJson(`${this.base}/api/v2/series`)) as MaSeriesResponse | null;
            const ok = Array.isArray(json?.results);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse API invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
