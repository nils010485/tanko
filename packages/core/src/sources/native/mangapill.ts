/**
 * Native connector for MangaPill (https://mangapill.com): pure SSR site,
 * search via GET /?q=, chapters list in div#chapters, reader images as
 * img[data-src] on a third-party B2/Cloudflare CDN.
 * Caveat: genre-filtered catalog pages are AND-logical and empty-query search
 * returns nothing usable — only free-text search is exposed.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, checkHealthViaSearch, fetchNativeText, fetchRefererImage, lazySrc, noPagesError } from './http.js';

export class MangaPillConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangapill';
    readonly label = 'MangaPill';
    readonly tags = ['manga', 'english'];
    private readonly base = 'https://mangapill.com';
    readonly url = this.base;

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
            const href = absoluteUrl(anchor.getAttribute('href'), this.base);
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
                thumbnail: lazySrc(anchor.querySelector('img'))
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('#chapters a')]) {
            const href = absoluteUrl(anchor.getAttribute('href'), this.base);
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
            .map(src => absoluteUrl(src, this.base))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw noPagesError(chapter, this);
        }
        return images;
    }

    /** The B2/Cloudflare image CDN now enforces the site Referer (403 otherwise). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        return fetchRefererImage(url, {
            id: this.id,
            referer: `${this.base}/`,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            error: (status, hostname) => `HTTP ${status} sur l'image CDN ${hostname}`
        });
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaSearch(this, 'one', 'Recherche vide (site modifié ?)');
    }
}
