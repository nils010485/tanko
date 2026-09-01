/**
 * Native connector for the FoolSlide reader platform (FoOlSlide): series list
 * at {base}{path} (POST adult=true to bypass the adult gate), chapters from
 * div.element rows on the series page, page image URLs from the embedded
 * `var pages = [...]` JSON on the chapter page.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface FoolSlideOptions {
    id: string;
    label: string;
    base: string;
    /** Series directory path (default /directory/). */
    path?: string;
    tags?: string[];
}

export class FoolSlideConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly directoryPath: string;

    constructor(options: FoolSlideOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.base = options.base.replace(/\/$/, '');
        this.directoryPath = options.path || '/directory/';
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    /** POST adult=true (FoolSlide adult gate); anti-bot shells render in Chromium. */
    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, {
            id: this.id,
            init: { method: 'POST', body: 'adult=true', headers: { 'content-type': 'application/x-www-form-urlencoded' } }
        });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const results = new Map<string, MangaInfo>();
        const visited = new Set<string>();
        const queue = [`${this.base}${this.directoryPath}`];
        while (queue.length > 0 && visited.size < 20) {
            const url = queue.shift() as string;
            if (visited.has(url)) {
                continue;
            }
            visited.add(url);
            const html = await this._getText(url);
            const document = parseDocument(html);
            for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>('div.list div.group > div.title a')]) {
                const href = this._absolute(anchor.getAttribute('href'));
                const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!href?.includes('/series/') || !title) {
                    continue;
                }
                if (needle && !title.toLowerCase().includes(needle)) {
                    continue;
                }
                if (!results.has(href)) {
                    const image = anchor.closest('div.group')?.querySelector('a[href*="/series/"] > img');
                    results.set(href, { id: href, title, url: href, thumbnail: image?.getAttribute('src') || undefined });
                }
            }
            const next = this._absolute(document.querySelector('div.prevnext div.next a')?.getAttribute('href'));
            if (next && !visited.has(next)) {
                queue.push(next);
            }
        }
        return [...results.values()];
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll<HTMLAnchorElement>('div.list div.element div.title a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title) {
                continue;
            }
            chapters.push({ id: href, title, url: href });
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const raw = html.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/)?.[1];
        if (!raw) {
            throw new SourceError(`Liste de pages introuvable pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        let pages: Array<{ url?: string }>;
        try {
            pages = JSON.parse(raw) as Array<{ url?: string }>;
        } catch (error) {
            throw new SourceError(`JSON de pages invalide pour "${chapter.title}" sur ${this.label}`, this.id, error);
        }
        const images = pages.map(page => this._absolute(page.url)).filter((src): src is string => !!src);
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
