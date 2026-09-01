/**
 * Native connector for Shoujo Hearts (http://shoujohearts.net — HTTP only,
 * the TLS certificate is self-signed). WordPress Madara reader under /reader/:
 * series from the projects page, chapters via the Madara ajax/chapters POST
 * (fallback: /reader/latest-releases/ filtered by series slug), pages as
 * .reading-content img (data-src, https URLs rewritten to http).
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface ShoujoHeartsOptions {
    id: string;
    label: string;
    /** Scheme + host, e.g. http://shoujohearts.net (keep http). */
    base: string;
    tags?: string[];
}

export class ShoujoHeartsConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: ShoujoHeartsOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga', 'shoujo'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    /** Resolve against base and force http (https serves a broken vhost). */
    private _absolute(href: string | undefined | null): string | null {
        const url = absoluteUrl(href, this.base);
        return url?.replace(/^https:/, 'http:') ?? null;
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id });
    }

    private _seriesAnchors(html: string): MangaInfo[] {
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href*="/reader/manga/"]')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title || seen.has(href) || href.includes('/chapter-')) {
                continue;
            }
            seen.add(href);
            results.push({ id: href, title, url: href });
        }
        return results;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        return (await this._seriesAnchors(await this._getText(`${this.base}/scantalation/`))).filter(
            manga => !needle || manga.title.toLowerCase().includes(needle)
        );
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = (manga.url || manga.id).replace(/\/?$/, '/');
        const slug = new URL(seriesUrl).pathname.match(/\/reader\/manga\/([^/]+)/)?.[1];
        const chapters: ChapterInfo[] = [];
        try {
            const response = await fetch(`${seriesUrl}ajax/chapters/`, {
                method: 'POST',
                headers: { 'user-agent': randomUserAgent(), 'x-requested-with': 'XMLHttpRequest' }
            });
            if (response.ok) {
                const document = parseDocument(await response.text());
                for (const anchor of [...document.querySelectorAll('li.wp-manga-chapter a')]) {
                    const href = this._absolute(anchor.getAttribute('href'));
                    const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!href || !title || href.startsWith('javascript:')) {
                        continue;
                    }
                    chapters.push({ id: href, url: href, title });
                }
            }
        } catch {
            /* fall back to latest releases below */
        }
        if (chapters.length === 0 && slug) {
            // static recent-chapters feed: rebuild this series' chapters from it
            const document = parseDocument(await this._getText(`${this.base}/reader/latest-releases/`));
            const seen = new Set<string>();
            for (const anchor of [...document.querySelectorAll('a[href*="/reader/manga/"]')]) {
                const href = this._absolute(anchor.getAttribute('href'));
                const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!href || !title || !href.includes(`/manga/${slug}/`) || !href.includes('/chapter-') || seen.has(href)) {
                    continue;
                }
                seen.add(href);
                chapters.push({ id: href, url: href, title });
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const document = parseDocument(await this._getText(chapter.url || chapter.id));
        const images = [...document.querySelectorAll('div.reading-content img')]
            .map(img => (img.getAttribute('data-src') || img.getAttribute('src') || '').trim())
            .filter(src => !!src && !src.startsWith('data:'))
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
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de séries vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
