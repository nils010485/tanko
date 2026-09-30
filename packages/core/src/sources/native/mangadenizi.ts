/**
 * Native MangaDenizi (Turkish) connector against its public JSON API
 * (custom Laravel + Nuxt; the old MangaReaderCMS endpoints are dead).
 *
 * LIMITATION (scramble): every page image on img.mangadenizi.net is
 * tile-scrambled — each page carries `scramble { method: "tiled-v1",
 * grid: 10, seed: <int> }` in the reader response, and the web reader
 * reassembles the tiles client-side. This connector does NOT descramble:
 * pages are returned as-is, i.e. visually shuffled (valid webp images,
 * grid-10 tile permutation per page). Implementing the tiled-v1
 * de-tiling (seed-driven) is required upstream for readable pages.
 *
 * Images answer 200 (image/webp) without any Referer, so no
 * fetchPageImage is needed.
 *
 * Chain: GET /api/v1/manga?page=N (catalog) | GET /api/search?q= (search) ->
 * GET /api/v1/manga/<slug> (series + latest 100 chapters) ->
 * GET /api/v1/reader/<slug>/<chapterSlug> (pages + full chapter list).
 */

import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { checkHealthViaProbe, fetchJson, noPagesError } from './http.js';

const API = 'https://www.mangadenizi.net';

interface DeniziCatalogResponse {
    data?: Array<{ slug?: string; title?: string; cover_url?: string }>;
}

interface DeniziSearchResponse {
    results?: Array<{ slug?: string; title?: string; cover_url?: string }>;
}

interface DeniziChapter {
    slug?: string;
    number?: string | number;
    title?: string | null;
}

interface DeniziMangaResponse {
    manga?: {
        title?: string;
        total_chapters_count?: number;
        chapters?: DeniziChapter[];
    };
}

interface DeniziReaderResponse {
    pages?: Array<{ image_url?: string }>;
}

export class MangadeniziConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangadenizi';
    readonly label = 'MangaDenizi';
    readonly tags = ['manga', 'turkish'];
    readonly url = API;

    async initialize(): Promise<void> {}

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        const results: MangaInfo[] = [];
        const items = needle
            ? (
                  await fetchJson<DeniziSearchResponse>(`${API}/api/search?q=${encodeURIComponent(needle)}`, {
                      id: this.id,
                      hostname: new URL(API).hostname,
                      label: this.label
                  })
              ).results || []
            : (
                  await fetchJson<DeniziCatalogResponse>(`${API}/api/v1/manga?page=1`, {
                      id: this.id,
                      hostname: new URL(API).hostname,
                      label: this.label
                  })
              ).data || [];
        for (const item of items) {
            if (!item.slug || !item.title) {
                continue;
            }
            results.push({ id: item.slug, title: item.title, url: `${API}/manga/${item.slug}`, thumbnail: item.cover_url });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const slug = manga.id.replace(/^.*\/manga\//, '').replace(/\/$/, '');
        const response = await fetchJson<DeniziMangaResponse>(`${API}/api/v1/manga/${slug}`, {
            id: this.id,
            hostname: new URL(API).hostname,
            label: this.label
        });
        const chapters: ChapterInfo[] = [];
        for (const chapter of response.manga?.chapters || []) {
            if (!chapter.slug) {
                continue;
            }
            const number = typeof chapter.number === 'number' ? String(chapter.number) : chapter.number || chapter.slug;
            const title = chapter.title?.trim() ? `${number}: ${chapter.title.trim()}` : `Bölüm ${number}`;
            chapters.push({
                id: chapter.slug,
                title,
                url: `${API}/manga/${slug}/${chapter.slug}`,
                language: 'tr'
            });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // newest first in the API -> chronological
        return chapters.reverse();
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const slug = manga.id.replace(/^.*\/manga\//, '').replace(/\/$/, '');
        const response = await fetchJson<DeniziReaderResponse>(`${API}/api/v1/reader/${slug}/${chapter.id}`, {
            id: this.id,
            hostname: new URL(API).hostname,
            label: this.label
        });
        const pages = (response.pages || []).map(page => page.image_url).filter((url): url is string => !!url);
        if (pages.length === 0) {
            throw noPagesError(chapter, this);
        }
        return pages;
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaProbe(async () => {
            const response = await fetchJson<DeniziCatalogResponse>(`${API}/api/v1/manga?page=1`, {
                id: this.id,
                hostname: new URL(API).hostname,
                label: this.label
            });
            return { ok: (response.data || []).length > 0, error: 'Catalogue vide (API modifiée ?)' };
        });
    }
}
