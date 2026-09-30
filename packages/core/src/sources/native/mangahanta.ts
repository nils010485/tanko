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
import { absoluteUrl, checkHealthViaSearch, fetchNativeText, noPagesError } from './http.js';

/** Safety cap for the admin-ajax chapter pagination (10 chapters/page). */
const MAX_CHAPTER_PAGES = 200;

interface LoadMorePayload {
    success?: boolean;
    data?: { html?: string; has_more?: boolean };
}

interface MangaHantaOptions {
    id: string;
    label: string;
    base: string;
    tags?: string[];
}

export class MangaHantaConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;
    private readonly lang = 'tr';

    constructor(options: MangaHantaOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga', 'turkish'];
        this.base = options.base.replace(/\/$/, '');
        this.url = `${this.base}/${this.lang}/`;
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': `${this.lang},*;q=0.5` } });
    }

    private _chapterAnchors(html: string): ChapterInfo[] {
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('a.chapter-link')]) {
            const href = absoluteUrl(anchor.getAttribute('href'), this.base);
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
            const href = absoluteUrl(anchor.getAttribute('href'), this.base);
            const title = (anchor.querySelector('h3.series-card-title')?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title || seen.has(href)) {
                continue;
            }
            seen.add(href);
            const style = anchor.querySelector('.series-card-thumb')?.getAttribute('style') || '';
            const thumbnail = style.match(/url\(['"]?([^'")]+)['"]?\)/)?.[1];
            results.push({ id: href, title, url: href, thumbnail: absoluteUrl(thumbnail, this.base) || undefined });
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
            .map(src => absoluteUrl(src, this.base))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw noPagesError(chapter, this);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaSearch(this, '', 'Liste de séries vide (site modifié ?)');
    }
}
