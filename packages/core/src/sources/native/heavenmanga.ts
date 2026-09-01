/**
 * Native connector for HeavenManga (https://heavenmanga.com): search via
 * GET /buscar?query=, chapters through a Laravel DataTables serverSide AJAX
 * on the series page (minimal draw/start/length params + XHR header), pages
 * extracted from "imgURL" JSON entries embedded in the /manga/leer/<id> reader.
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

export interface HeavenMangaOptions {
    id?: string;
    label?: string;
    base?: string;
    tags?: string[];
}

interface DataTablesRow {
    id?: number | string;
    slug?: string;
    name?: string | null;
    number?: string;
}

interface DataTablesResponse {
    recordsTotal?: number;
    recordsFiltered?: number;
    data?: DataTablesRow[];
}

/** DataTables page size: proven minimal-param set is draw=1&start=0&length=N. */
const CHAPTERS_PAGE_SIZE = 1000;

export class HeavenMangaConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: HeavenMangaOptions = {}) {
        this.id = options.id || 'heavenmanga2';
        this.label = options.label || 'HeavenManga';
        this.tags = options.tags || ['manga', 'spanish'];
        this.base = (options.base || 'https://heavenmanga.com').replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id });
    }

    /** DataTables serverSide query: minimal params only (columns[...] makes it 500). */
    private async _getJson(url: string): Promise<DataTablesResponse> {
        const response = await fetch(url, {
            headers: {
                'user-agent': randomUserAgent(),
                accept: 'application/json, text/javascript, */*; q=0.01',
                'x-requested-with': 'XMLHttpRequest',
                referer: url.split('?')[0]
            },
            redirect: 'follow'
        });
        const body = await response.text().catch(() => '');
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur DataTables (${new URL(url).pathname})`, this.id);
        }
        try {
            return JSON.parse(body) as DataTablesResponse;
        } catch {
            throw new SourceError(`Réponse DataTables non-JSON sur ${new URL(url).pathname}`, this.id);
        }
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        if (!needle) {
            throw new SourceError('Recherche vide non supportée par HeavenManga (réponse de ~53 Mo)', this.id);
        }
        const html = await this._getText(`${this.base}/buscar?query=${encodeURIComponent(needle)}`);
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        // search results use c-tabs-item cards (page-item-detail was the old /top markup)
        for (const anchor of [...document.querySelectorAll('a[href*="/manga/"]')] as Array<HTMLAnchorElement>) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href || seen.has(href)) {
                continue;
            }
            const path = new URL(href).pathname;
            // keep series pages only (/manga/<slug>): drop /manga/leer/<id> and /manga/<slug>/<n> chapter links
            if (!/^\/manga\/[^/]+$/.test(path)) {
                continue;
            }
            const img = anchor.querySelector('img');
            const title = (
                anchor.getAttribute('title') ||
                anchor.querySelector('h3, h4, h5')?.textContent ||
                anchor.textContent ||
                img?.getAttribute('alt') ||
                ''
            )
                .replace(/\s+/g, ' ')
                .trim();
            if (!title) {
                continue;
            }
            seen.add(href);
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
        const seriesUrl = manga.url || manga.id;
        try {
            const json = await this._getJson(`${seriesUrl}?draw=1&start=0&length=${CHAPTERS_PAGE_SIZE}`);
            const sortable: Array<{ chapter: ChapterInfo; number: number }> = [];
            for (const row of json.data ?? []) {
                // the number HTML fragment carries the canonical /manga/leer/<id> link; slug is the chapter number
                const fragment = String(row.number || '');
                const leer = fragment.match(/\/manga\/leer\/(\d+)/)?.[1] ?? (row.id != null ? String(row.id) : undefined);
                if (!leer) {
                    continue;
                }
                const url = `${this.base}/manga/leer/${leer}`;
                const number = row.slug || fragment.match(/number="([^"]*)"/)?.[1] || leer;
                const title = (row.name || `Capítulo ${number}`).replace(/\s+/g, ' ').trim();
                sortable.push({
                    chapter: { id: url, title, url },
                    number: Number.parseFloat(String(number).replace(/[^0-9.]/g, '')) || 0
                });
            }
            if (sortable.length > 0) {
                return sortable.sort((a, b) => a.number - b.number).map(entry => entry.chapter);
            }
        } catch {
            /* fall through to static table parsing */
        }
        // fallback: legacy static table markup
        const html = await this._getText(seriesUrl);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('table.table tr td h4.title a, table#dataTableBuilder a')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href?.includes('/manga/leer/')) {
                continue;
            }
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            chapters.push({ id: href, title, url: href });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        return chapters;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        let html = await this._getText(chapterUrl);
        let document = parseDocument(html);
        // chapter page redirects through a#leer to the actual reader
        const leer = document.querySelector('a#leer')?.getAttribute('href');
        if (leer) {
            const readerUrl = this._absolute(leer);
            if (readerUrl && readerUrl !== chapterUrl) {
                html = await this._getText(readerUrl);
                document = parseDocument(html);
            }
        }
        // reader embeds the page list as "imgURL": "<url>" JSON-ish entries
        const images: string[] = [];
        for (const match of html.matchAll(/['"]imgURL['"]\s*:\s*['"]([^'"]+)['"]/g)) {
            const url = this._absolute(match[1].replace(/\\\//g, '/'));
            if (url && !images.includes(url)) {
                images.push(url);
            }
        }
        if (images.length === 0) {
            for (const img of [...document.querySelectorAll('div.lecteur img, #content img, img[src*="i.ibb.co"]')]) {
                const src = this._absolute(img.getAttribute('src') || img.getAttribute('data-src'));
                if (src && !images.includes(src)) {
                    images.push(src);
                }
            }
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const mangas = await this.searchMangas('tower');
            if (mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Recherche vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: String(error instanceof Error ? error.message : error) };
        }
    }
}
