/**
 * Native connector for MangaHanta (https://www.mangahanta.com, Turkish, /tr/).
 * WordPress "MangaVerse" theme: search GET /{lang}/?s=..&post_type=wp-manga
 * (series-card grid), chapters .chapters-list a.chapter-link completed by the
 * admin-ajax mangaverse_load_more pagination, pages img[data-src]
 * (cdn.mangahanta.com).
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

/** Safety cap for the admin-ajax chapter pagination (10 chapters/page). */
const MAX_CHAPTER_PAGES = 200;

interface LoadMorePayload {
    success?: boolean;
    data?: { html?: string; has_more?: boolean };
}

export interface MangaHantaOptions {
    id: string;
    label: string;
    base: string;
    /** Content language prefix (default tr; en also exists). */
    lang?: string;
    tags?: string[];
}

export class MangaHantaConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly lang: string;

    constructor(options: MangaHantaOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga', 'turkish'];
        this.base = options.base.replace(/\/$/, '');
        this.lang = options.lang || 'tr';
        this.url = `${this.base}/${this.lang}/`;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': `${this.lang},*;q=0.5` } });
    }

    private _chapterAnchors(html: string): ChapterInfo[] {
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('a.chapter-link')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.querySelector('h3.chapter-title')?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title) {
                continue;
            }
            chapters.push({ id: href, url: href, title });
        }
        return chapters;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = `${this.base}/${this.lang}/?s=${encodeURIComponent(query.trim())}&post_type=wp-manga`;
        const document = parseDocument(await this._getText(url));
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('div.series-card a.series-card-link')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.querySelector('h3.series-card-title')?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title || seen.has(href)) {
                continue;
            }
            seen.add(href);
            const style = anchor.querySelector('.series-card-thumb')?.getAttribute('style') || '';
            const thumbnail = style.match(/url\(['"]?([^'")]+)['"]?\)/)?.[1];
            results.push({ id: href, title, url: href, thumbnail: this._absolute(thumbnail) || undefined });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = (manga.url || manga.id).replace(/\/?$/, '');
        const html = await this._getText(seriesUrl);
        const document = parseDocument(html);
        const byUrl = new Map<string, ChapterInfo>();
        for (const chapter of this._chapterAnchors(html)) {
            byUrl.set(chapter.id, chapter);
        }
        const categoryId = document.querySelector('.chapters-list')?.getAttribute('data-category');
        const config = html.slice(html.indexOf('mangaverse_ajax'), html.indexOf('mangaverse_ajax') + 800);
        const nonce = config.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1];
        const lang = config.match(/"current_lang"\s*:\s*"([^"]+)"/)?.[1] || seriesUrl.match(/https?:\/\/[^/]+\/(tr|en)\//)?.[1] || this.lang;
        if (categoryId && nonce) {
            try {
                for (let page = 1; page <= MAX_CHAPTER_PAGES; page++) {
                    const body = new URLSearchParams({
                        action: 'mangaverse_load_more',
                        nonce,
                        page: String(page),
                        type: 'series',
                        category_id: categoryId,
                        order: 'desc',
                        lang
                    });
                    const response = await fetch(`${this.base}/wp-admin/admin-ajax.php`, {
                        method: 'POST',
                        headers: {
                            'user-agent': randomUserAgent(),
                            'content-type': 'application/x-www-form-urlencoded',
                            'x-requested-with': 'XMLHttpRequest'
                        },
                        body
                    });
                    const payload = (await response.json().catch(() => undefined)) as LoadMorePayload | undefined;
                    for (const chapter of this._chapterAnchors(payload?.data?.html || '')) {
                        byUrl.set(chapter.id, chapter);
                    }
                    if (!payload?.data?.has_more) {
                        break;
                    }
                }
            } catch {
                /* keep the chapters embedded in the series page */
            }
        }
        if (byUrl.size === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        // desc order (newest first) -> chronological
        return [...byUrl.values()].reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const document = parseDocument(await this._getText(chapter.url || chapter.id));
        const images = [...document.querySelectorAll('div.entry-content img')]
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
