/**
 * Native connector for 3Hentai (https://3hentai.net): pure HTML doujin
 * gallery. Search via GET /search?q=, gallery pages at /d/<id> (the legacy
 * /g/ routes are dead), full-size images derived from #thumbnail-gallery
 * thumbs by stripping the trailing "t" before the extension.
 * Galleries are single-chapter readers: the chapter is the gallery itself.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface ThreeHentaiOptions {
    id?: string;
    label?: string;
    base?: string;
    tags?: string[];
}

export class ThreeHentaiConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: ThreeHentaiOptions = {}) {
        this.id = options.id || '3hentai';
        this.label = options.label || '3Hentai';
        this.tags = options.tags || ['manga', 'hentai', 'english'];
        this.base = (options.base || 'https://3hentai.net').replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        if (!needle) {
            throw new SourceError('Recherche vide non supportée par 3Hentai', this.id);
        }
        const html = await this._getText(`${this.base}/search?q=${encodeURIComponent(needle)}&page=1`);
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href^="/d/"], a[href*="/d/"]')] as Array<HTMLAnchorElement>) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href) {
                continue;
            }
            const match = new URL(href).pathname.match(/^\/d\/(\d+)\/?$/);
            if (!match) {
                continue;
            }
            const galleryId = match[1];
            if (seen.has(galleryId)) {
                continue;
            }
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title) {
                continue;
            }
            seen.add(galleryId);
            results.push({
                id: href,
                title,
                url: href,
                thumbnail: anchor.querySelector('img')?.getAttribute('data-src') || anchor.querySelector('img')?.getAttribute('src') || undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        // doujin gallery: single chapter = the gallery itself
        const url = manga.url || manga.id;
        return [{ id: url, title: manga.title, url }];
    }

    async getPages(manga: MangaInfo, _chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const images: string[] = [];
        for (const img of [...document.querySelectorAll('#thumbnail-gallery img[data-src], #thumbnail-gallery img')]) {
            const src = img.getAttribute('data-src') || img.getAttribute('src');
            if (!src) {
                continue;
            }
            // thumb  https://s1.3hentai.xyz/<hash>/<n>t.jpg -> full .../<n>.jpg
            const full = src.replace(/(\d)t(\.(?:jpe?g|png|webp|gif))$/i, '$1$2');
            const url = this._absolute(full);
            if (url && !images.includes(url)) {
                images.push(url);
            }
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${manga.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const mangas = await this.searchMangas('milk');
            if (mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Recherche vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
