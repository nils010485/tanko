/**
 * Native connector for MangaPill (https://mangapill.com): pure SSR site,
 * search via GET /?q=, chapters list in div#chapters, reader images as
 * img[data-src] on a third-party B2/Cloudflare CDN.
 * Caveat: genre-filtered catalog pages are AND-logical and empty-query search
 * returns nothing usable — only free-text search is exposed.
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface MangaPillOptions {
    id?: string;
    label?: string;
    base?: string;
    tags?: string[];
}

export class MangaPillConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: MangaPillOptions = {}) {
        this.id = options.id || 'mangapill';
        this.label = options.label || 'MangaPill';
        this.tags = options.tags || ['manga', 'english'];
        this.base = (options.base || 'https://mangapill.com').replace(/\/$/, '');
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
            throw new SourceError('La recherche vide ne retourne aucun résultat sur MangaPill (catalogue par genre dégradé)', this.id);
        }
        const html = await this._getText(`${this.base}/?q=${encodeURIComponent(needle)}`);
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a.mb-2')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href || !/\/manga\/\d+\//.test(href) || seen.has(href)) {
                continue;
            }
            const title = (anchor.querySelector('div, h3, span')?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title) {
                continue;
            }
            seen.add(href);
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
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('div#chapters a, #chapters a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href?.includes('/chapters/')) {
                continue;
            }
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({ id: href, title, url: href });
        }
        // site lists newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('img[data-src], source[data-src]')]
            .map(el => el.getAttribute('data-src'))
            .filter((src): src is string => !!src && !src.startsWith('data:'))
            .map(src => this._absolute(src))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    /** The B2/Cloudflare image CDN now enforces the site Referer (403 otherwise). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8', referer: `${this.base}/` }
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur l'image CDN ${new URL(url).hostname}`, this.id);
        }
        const buffer = await response.arrayBuffer();
        return { mime: response.headers.get('content-type') || 'image/jpeg', data: new Uint8Array(buffer) };
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const mangas = await this.searchMangas('one');
            if (mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Recherche vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
