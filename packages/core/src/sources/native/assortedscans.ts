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

import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { checkHealthViaProbe, fetchJson, noPagesError } from './http.js';

interface MaSeries {
    slug: string;
    title: string;
    cover?: string;
}

interface MaSeriesResponse {
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
    private readonly base = 'https://assortedscans.com';
    readonly url = this.base;

    async initialize(): Promise<void> {}

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        // server-side title filter when given; otherwise walk all pages
        // (/api/v2/series without trailing slash, else HTTP 501)
        const results: MaSeries[] = [];
        if (needle) {
            const json = await fetchJson<MaSeriesResponse>(`${this.base}/api/v2/series?title=${encodeURIComponent(needle)}`, {
                id: this.id,
                timeoutMs: 30_000,
                label: this.label
            });
            results.push(...(json.results ?? []));
        } else {
            for (let page = 1; page <= 20; page++) {
                const json = await fetchJson<MaSeriesResponse>(`${this.base}/api/v2/series?page=${page}`, {
                    id: this.id,
                    timeoutMs: 30_000,
                    label: this.label
                });
                results.push(...(json.results ?? []));
                if (json?.last !== false || !json.results?.length) {
                    break;
                }
            }
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
        const json = await fetchJson<MaChaptersResponse>(`${this.base}/api/v2/series/${slug}/chapters`, { id: this.id, timeoutMs: 30_000, label: this.label });
        const chapters = json.results;
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
        const json = await fetchJson<MaPagesResponse>(endpoint, { id: this.id, timeoutMs: 30_000, label: this.label });
        const images = (json.results || []).map(page => page.image).filter((image): image is string => !!image);
        if (images.length === 0) {
            throw noPagesError(chapter, this);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaProbe(async () => {
            const json = await fetchJson<MaSeriesResponse>(`${this.base}/api/v2/series`, { id: this.id, timeoutMs: 30_000, label: this.label });
            return { ok: Array.isArray(json.results), error: 'Réponse API invalide' };
        });
    }
}
