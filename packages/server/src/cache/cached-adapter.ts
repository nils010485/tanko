/**
 * Caching decorator around a SourceAdapter:
 *  - legacy sources: the full manga list is cached (24h) and searches are
 *    filtered locally — catalog-scanning connectors (e.g. 11toon) go from
 *    minutes to instant after the first fetch
 *  - all sources: chapter lists are cached (30 min)
 * Pages are never cached (image URLs are often short-lived).
 */
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '@tanko/core';
import type { CacheStore } from './cache.js';

const MANGA_LIST_TTL_SECONDS = 24 * 3600;
const CHAPTERS_TTL_SECONDS = 30 * 60;

export class CachedSourceAdapter implements SourceAdapter {
    constructor(
        private readonly inner: SourceAdapter,
        private readonly cache: CacheStore
    ) {}

    get id(): string {
        return this.inner.id;
    }

    get label(): string {
        return this.inner.label;
    }

    get tags(): string[] {
        return this.inner.tags;
    }

    get kind(): 'legacy' | 'native' {
        return this.inner.kind;
    }

    get url(): string | undefined {
        return this.inner.url;
    }

    initialize(): Promise<void> {
        return this.inner.initialize();
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        // native sources use the site's own (fast) search endpoint -> no list cache
        if (this.inner.kind === 'native') {
            return this.inner.searchMangas(query);
        }
        const key = `src:mangas:${this.id}`;
        let list = await this.cache.get<MangaInfo[]>(key);
        if (!list) {
            // empty query = full list for legacy adapters
            list = await this.inner.searchMangas('');
            // never cache an empty list (anti-bot / transient failure would
            // otherwise poison the cache for 24h)
            if (list.length > 0) {
                await this.cache.set(key, list, MANGA_LIST_TTL_SECONDS);
            }
        }
        const needle = query.trim().toLowerCase();
        if (!needle) {
            return list;
        }
        return list.filter(manga => manga.title.toLowerCase().includes(needle));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const key = `src:chapters:${this.id}:${manga.id}`;
        const cached = await this.cache.get<ChapterInfo[]>(key);
        if (cached) {
            return cached;
        }
        const chapters = await this.inner.getChapters(manga);
        if (chapters.length > 0) {
            await this.cache.set(key, chapters, CHAPTERS_TTL_SECONDS);
        }
        return chapters;
    }

    getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        return this.inner.getPages(manga, chapter);
    }

    checkHealth(): Promise<HealthResult> {
        return this.inner.checkHealth();
    }
}
