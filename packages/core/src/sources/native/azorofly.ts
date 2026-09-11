/**
 * Native connector for Azora Manga (https://azorafly.com, arabic/RTL): the
 * same Astro/VComics platform as VComicsConnector (report
 * scripts/casework/azoraworld.md — the legacy azoramoon.com domain redirects
 * here; no Madara, no WordPress). Only search (bigger page + 'a' fallback
 * for the empty query) and the reader markup differ from the base connector.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, MangaInfo, PageList } from '../types.js';
import { SourceError } from '../types.js';
import { VComicsConnector } from './vcomics.js';

export class AzoraFlyConnector extends VComicsConnector {
    constructor() {
        super({ id: 'azoraworld', label: 'Azora Manga', base: 'https://azorafly.com', tags: ['manga', 'manhwa', 'arabic'], language: 'ar' });
    }

    /** Same /api/query endpoint as the base connector, but with the page size
     *  the site honours and an 'a' fallback so the empty query still lists. */
    override async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = `${this.base}/api/query?searchTerm=${encodeURIComponent(query.trim() || 'a')}&perPage=100`;
        const json = (await this._getJson(url)) as { posts?: Array<{ slug?: string; postTitle?: string; featuredImage?: string }> } | null;
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

    /** Reader images: img[data-reader-page-image] sorted by data-reader-index
     *  on /series/{slug}/chapter-{n} (plain storage.azorafly.com CDN urls). */
    override async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
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
}
