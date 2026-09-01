/**
 * Native connector for the "Mangastream" WordPress theme
 * (https://themesia.com/mangastream-wordpress-theme/): series list at
 * {base}{path}, chapters as .eph-num rows, reader images from the embedded
 * ts_reader JSON (fallback: #readerarea imgs).
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface MangastreamOptions {
    id: string;
    label: string;
    base: string;
    /** Series list path (default /list/; some sites use /series/list-mode). */
    path?: string;
    tags?: string[];
}

export class MangastreamConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly listPath: string;

    constructor(options: MangastreamOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.base = options.base.replace(/\/$/, '');
        this.listPath = options.path || '/list/';
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    /** Fetch HTML with a browser UA; anti-bot shells render in Chromium. */
    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}${this.listPath}`);
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results: MangaInfo[] = [];
        for (const anchor of [...document.querySelectorAll('div.soralist ul li a.series, .listupd .bs a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title || href.includes('/chapter/')) {
                continue;
            }
            if (needle && !title.toLowerCase().includes(needle)) {
                continue;
            }
            const img = anchor.querySelector('img');
            results.push({
                id: href,
                title,
                url: href,
                thumbnail: img?.getAttribute('data-src') || img?.getAttribute('src') || undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('div#chapterlist ul li div.eph-num a, .eplister ul li a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href) {
                continue;
            }
            const num = anchor.querySelector('.chapternum')?.textContent?.replace(/\s+/g, ' ').trim();
            const title = num || (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({ id: href, title, url: href });
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        // reader payloads are embedded server-side: ts_reader.run({...sources:[{images:[...]}]})
        const json = html.match(/ts_reader\.run\((\{.*?\})\);?\s*<\/script>/s)?.[1];
        if (json) {
            try {
                const parsed = JSON.parse(json) as { sources?: Array<{ images?: string[] }> };
                const images = parsed.sources?.[0]?.images ?? [];
                const absolute = images.map(src => this._absolute(src)).filter((src): src is string => !!src);
                if (absolute.length > 0) {
                    return absolute;
                }
            } catch {
                /* fall through to DOM parsing */
            }
        }
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('div#readerarea img')]
            .map(img => img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('src'))
            .filter((src): src is string => !!src && !src.startsWith('data:'))
            .map(src => this._absolute(src))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
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
