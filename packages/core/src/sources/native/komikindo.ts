/**
 * Native connector for KomikIndo (https://komikindo.ch, former komikindo.id).
 * No server-side search: searchMangas filters the paginated catalog locally.
 * Series /komik/<slug>/, chapters #chapter_list .lchx a, pages #chimg-auh img.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

/** Catalog pages scanned for a local (client-side) title search. */
const SEARCH_PAGES = 5;

export interface KomikIndoOptions {
    id: string;
    label: string;
    base: string;
    tags?: string[];
}

export class KomikIndoConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: KomikIndoOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': 'id,*;q=0.5' } });
    }

    private _listUrl(page: number): string {
        return page <= 1 ? `${this.base}/manga/?list` : `${this.base}/manga/page/${page}/?list`;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        const pages = needle ? SEARCH_PAGES : 1;
        for (let page = 1; page <= pages; page++) {
            const document = parseDocument(await this._getText(this._listUrl(page)));
            for (const anchor of [...document.querySelectorAll('div.listupd .animepost a')]) {
                const href = this._absolute(anchor.getAttribute('href'));
                if (!href || seen.has(href)) {
                    continue;
                }
                const isSeries = /\/komik\/[^/]+\/?$/.test(new URL(href).pathname);
                if (!isSeries) {
                    continue;
                }
                const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!title || (needle && !title.toLowerCase().includes(needle))) {
                    continue;
                }
                seen.add(href);
                const img = anchor.querySelector('img');
                results.push({
                    id: href,
                    title,
                    url: href,
                    thumbnail: img?.getAttribute('data-src') || img?.getAttribute('src') || undefined
                });
            }
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const document = parseDocument(await this._getText(manga.url || manga.id));
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('div#chapter_list span.lchx a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href) {
                continue;
            }
            const text = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            const num = text.match(/chapter\s*([\d.]+)/i)?.[1];
            chapters.push({ id: href, url: href, title: num ? `Chapter ${num}` : text });
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const document = parseDocument(await this._getText(chapter.url || chapter.id));
        const images = [...document.querySelectorAll('div#chimg-auh img')]
            .map(img => img.getAttribute('src') || img.getAttribute('data-src'))
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
