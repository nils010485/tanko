/**
 * Native connector for Natsu (https://natsu.one, successor of natsu.id).
 * Index via the open WordPress REST API (/wp-json/wp/v2/manga), chapters via
 * the server-rendered series page (fallback: /wp-json/wp/v2/chapter search),
 * pages as section[data-image-data] img (cdn.natsu.id).
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

/** Catalog pages scanned by the search fallback (empty search + local filter). */
const FALLBACK_PAGES = 5;
/** Safety cap for the chapter REST fallback. */
const CHAPTER_API_PAGES = 20;

interface WpManga {
    id?: number;
    slug?: string;
    link?: string;
    title?: { rendered?: string };
}

interface WpChapter {
    id?: number;
    slug?: string;
}

function decodeEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#8217;/g, '’')
        .replace(/&#8211;/g, '–')
        .replace(/&#8230;/g, '…');
}

export interface NatsuOneOptions {
    id: string;
    label: string;
    base: string;
    tags?: string[];
}

export class NatsuOneConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: NatsuOneOptions) {
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
        return fetchNativeText(url, { id: this.id });
    }

    private async _getJson<T>(url: string): Promise<T> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'application/json' },
            redirect: 'follow'
        }).catch(() => undefined);
        if (!response?.ok) {
            throw new SourceError(`API injoignable (${response ? `HTTP ${response.status}` : 'réseau'}) sur ${new URL(url).hostname}`, this.id);
        }
        return (await response.json().catch(() => {
            throw new SourceError(`Réponse JSON invalide sur ${new URL(url).hostname}`, this.id);
        })) as T;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const api = `${this.base}/wp-json/wp/v2/manga`;
        let items: WpManga[] = [];
        if (needle) {
            items = await this._getJson<WpManga[]>(`${api}?search=${encodeURIComponent(needle)}&per_page=100`);
        }
        if (items.length === 0) {
            // browse the catalog (page 1 for an empty query, a few pages otherwise) and filter locally
            for (let page = 1; page <= (needle ? FALLBACK_PAGES : 1); page++) {
                const batch = await this._getJson<WpManga[]>(`${api}?per_page=100&page=${page}`);
                items.push(...batch);
                if (batch.length < 100) {
                    break;
                }
            }
            if (needle) {
                items = items.filter(item => item.title?.rendered?.toLowerCase().includes(needle) || item.slug?.toLowerCase().includes(needle));
            }
        }
        return items
            .map((item): MangaInfo | null => {
                const link = this._absolute(item.link);
                const title = decodeEntities(item.title?.rendered || '')
                    .replace(/<[^>]+>/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                return link && title ? { id: link, title, url: link } : null;
            })
            .filter((item): item is MangaInfo => item !== null);
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = (manga.url || manga.id).replace(/\/?$/, '/');
        const document = parseDocument(await this._getText(seriesUrl));
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href*="/chapter-"]')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            // only chapters of this series (the page embeds "latest updates" from other series)
            if (!href?.startsWith(seriesUrl) || seen.has(href)) {
                continue;
            }
            seen.add(href);
            const num = href.match(/chapter-([\d.]+)\.\d+\/?$/)?.[1] ?? href.match(/chapter-(\d+(?:\.\d+)?)[./]/)?.[1];
            const label = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({ id: href, url: href, title: num ? `Chapter ${num}` : label });
        }
        if (chapters.length === 0) {
            chapters.push(...(await this._chaptersFromApi(seriesUrl)));
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        const number = (chapter: ChapterInfo) => Number(chapter.title.match(/[\d.]+/)?.[0] ?? 0);
        return chapters.sort((a, b) => number(a) - number(b));
    }

    /** REST fallback when the series page has no server-rendered chapter links. */
    private async _chaptersFromApi(seriesUrl: string): Promise<ChapterInfo[]> {
        const slug = new URL(seriesUrl).pathname.match(/\/manga\/([^/]+)/)?.[1];
        if (!slug) {
            return [];
        }
        const chapters: ChapterInfo[] = [];
        for (let page = 1; page <= CHAPTER_API_PAGES; page++) {
            const items = await this._getJson<WpChapter[]>(
                `${this.base}/wp-json/wp/v2/chapter?search=${encodeURIComponent(slug)}&per_page=100&page=${page}`
            ).catch(() => [] as WpChapter[]);
            if (items.length === 0) {
                break;
            }
            for (const item of items) {
                const num = item.slug?.match(/chapter-([\d.]+)$/)?.[1];
                if (!num || !item.id) {
                    continue;
                }
                const url = `${seriesUrl}chapter-${num}.${item.id}/`;
                chapters.push({ id: url, url, title: `Chapter ${num}` });
            }
        }
        return chapters;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const document = parseDocument(await this._getText(chapter.url || chapter.id));
        const images = [...document.querySelectorAll('section[data-image-data] img')]
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
            const items = await this._getJson<WpManga[]>(`${this.base}/wp-json/wp/v2/manga?per_page=1`);
            if (items.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'API répond mais catalogue vide' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
