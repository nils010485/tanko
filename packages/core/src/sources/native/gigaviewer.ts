/**
 * Native connector for the GigaViewer / CoreView platform (Shogakukan,
 * Kodansha, Futabasha, ...): series list at {base}{paths} (hashed
 * SeriesListItem_* markup or the serial-contents/subpage-table-list variant),
 * chapters via the Atom feed linked from any episode page
 * ({base}/atom/series/<id>?free_only=0), reader pages from the embedded
 * #episode-json script (readableProduct.pageStructure.pages[].src).
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface GigaViewerOptions {
    id: string;
    label: string;
    base: string;
    /** Series list paths (default ['/series', '/series/oneshot']). */
    paths?: string[];
    tags?: string[];
}

interface EpisodeJSON {
    readableProduct?: {
        isPublic?: boolean;
        hasPurchased?: boolean;
        pageStructure?: {
            pages?: Array<{ type?: string; src?: string }>;
        };
    };
}

export class GigaViewerConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly paths: string[];

    constructor(options: GigaViewerOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.base = options.base.replace(/\/$/, '');
        this.paths = options.paths || ['/series', '/series/oneshot'];
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    /** Fetch HTML with a browser UA; anti-bot shells render in Chromium. */
    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': 'ja,en,*;q=0.5' } });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const results = new Map<string, MangaInfo>();
        for (const path of this.paths) {
            const html = await this._getText(`${this.base}${path}`);
            const document = parseDocument(html);
            for (const item of [...document.querySelectorAll('li[class^="SeriesListItem_item__"], ul.series-table-list > li.subpage-table-list-item')]) {
                const anchor = item.querySelector('a[href*="/episode/"]');
                const href = this._absolute(anchor?.getAttribute('href'));
                if (!href || results.has(href)) {
                    continue;
                }
                const title = (
                    item.querySelector('h3[class^="SeriesListItem_title__"], h4.title')?.textContent ||
                    anchor?.querySelector('img')?.getAttribute('alt') ||
                    anchor?.textContent ||
                    ''
                )
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!title || (needle && !title.toLowerCase().includes(needle))) {
                    continue;
                }
                const image = anchor?.querySelector('img');
                const thumbnail = [image?.getAttribute('src'), image?.getAttribute('data-src')].find(
                    (src): src is string => !!src && !src.includes('{') && !src.includes('spacer')
                );
                results.set(href, { id: href, title, url: href, thumbnail });
            }
        }
        return [...results.values()];
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const atomHref = parseDocument(html).querySelector('link[rel="alternate"][type="application/atom+xml"]')?.getAttribute('href');
        if (!atomHref) {
            throw new SourceError(`Flux Atom introuvable pour "${manga.title}" sur ${this.label}`, this.id);
        }
        const atomUrl = new URL(atomHref, this.base);
        atomUrl.search = '';
        atomUrl.searchParams.set('free_only', '0');
        const feed = parseDocument(await this._getText(atomUrl.href));
        const chapters: ChapterInfo[] = [];
        for (const entry of [...feed.querySelectorAll('entry')]) {
            const href = this._absolute(entry.querySelector('link')?.getAttribute('href'));
            if (!href) {
                continue;
            }
            const entryTitle = (entry.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
            const title = manga.title ? entryTitle.replace(manga.title, '').trim() || entryTitle : entryTitle;
            chapters.push({ id: href, title, url: href });
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const raw = parseDocument(html).querySelector('script#episode-json')?.getAttribute('data-value');
        if (!raw) {
            throw new SourceError(`episode-json introuvable pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        let episode: EpisodeJSON;
        try {
            episode = JSON.parse(raw) as EpisodeJSON;
        } catch (error) {
            throw new SourceError(`episode-json invalide pour "${chapter.title}" sur ${this.label}`, this.id, error);
        }
        const product = episode.readableProduct;
        if (!product?.isPublic && !product?.hasPurchased) {
            throw new SourceError(`Le chapitre "${chapter.title}" n'est ni public, ni acheté sur ${this.label}`, this.id);
        }
        const images = (product?.pageStructure?.pages || [])
            .filter(page => page.type === 'main')
            .map(page => this._absolute(page.src))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw new SourceError(`Aucune page pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const mangas = await this.searchMangas('');
            if (mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de mangas vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
