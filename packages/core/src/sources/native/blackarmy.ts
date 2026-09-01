/**
 * Native connector for Black Army (https://blackarmy.fr). WordPress custom
 * theme: series archive /serie/ (24 cards), chapters a.chapter-card, pages
 * behind an admin-ajax POST (action=check_chapter) whose id+nonce are
 * embedded in the chapter HTML; images arrive unordered with ad interstitials.
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

/** Archive pages scanned for a local (client-side) title search. */
const SEARCH_PAGES = 5;

interface AjaxChapterPayload {
    success?: boolean;
    data?: { locked?: boolean; images?: unknown[] };
}

export interface BlackArmyOptions {
    id: string;
    label: string;
    base: string;
    tags?: string[];
}

export class BlackArmyConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: BlackArmyOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga', 'french'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': 'fr,*;q=0.5' } });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        const pages = needle ? SEARCH_PAGES : 1;
        for (let page = 1; page <= pages; page++) {
            const path = page === 1 ? '/serie/' : `/serie/page/${page}/`;
            const document = parseDocument(await this._getText(`${this.base}${path}`));
            for (const anchor of [...document.querySelectorAll('div.manga-card a.manga-title')]) {
                const href = this._absolute(anchor.getAttribute('href'));
                const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!href || !title || seen.has(href)) {
                    continue;
                }
                if (needle && !title.toLowerCase().includes(needle)) {
                    continue;
                }
                seen.add(href);
                const img = anchor.closest('div.manga-card')?.querySelector('img');
                results.push({
                    id: href,
                    title,
                    url: href,
                    thumbnail: img?.getAttribute('data-lazy-src') || img?.getAttribute('src') || undefined
                });
            }
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const document = parseDocument(await this._getText(manga.url || manga.id));
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('a.chapter-card')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const title = (anchor.querySelector('span.chapter-card-title')?.textContent || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title) {
                continue;
            }
            chapters.push({ id: href, url: href, title });
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        // reader credentials are appended right after the check_chapter action
        const marker = html.indexOf("'check_chapter'");
        const chunk = html.slice(marker, marker + 400);
        const chapterId = marker >= 0 ? chunk.match(/chapitre_id',\s*'(\d+)'/)?.[1] : undefined;
        const nonce = marker >= 0 ? chunk.match(/nonce',\s*'([a-f0-9]+)'/)?.[1] : undefined;
        if (!chapterId || !nonce) {
            throw new SourceError(`Lecteur AJAX introuvable pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        const form = new FormData();
        form.append('action', 'check_chapter');
        form.append('chapitre_id', chapterId);
        form.append('nonce', nonce);
        let response: Response | undefined;
        try {
            response = await fetch(`${this.base}/wp-admin/admin-ajax.php`, {
                method: 'POST',
                headers: { 'user-agent': randomUserAgent(), referer: chapterUrl, 'x-requested-with': 'XMLHttpRequest' },
                body: form
            });
        } catch {
            /* fall through to the error below */
        }
        const text = response ? await response.text().catch(() => '') : '';
        let payload: AjaxChapterPayload | undefined;
        try {
            payload = JSON.parse(text) as AjaxChapterPayload;
        } catch {
            /* invalid payload -> error below */
        }
        if (!response?.ok || !payload?.success) {
            throw new SourceError(`Lecteur AJAX a échoué (HTTP ${response?.status ?? 'réseau'}) pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        if (payload.data?.locked) {
            throw new SourceError(`Chapitre VIP (verrouillé) : "${chapter.title}" sur ${this.label}`, this.id);
        }
        // drop ad interstitials (lss.jpg) and sort by the -pN page marker in the filename
        const images = (payload.data?.images || []).filter((url): url is string => typeof url === 'string' && !/\/lss\.[a-z]+$/i.test(url));
        const ordered = images
            .map((url, index) => ({ url, index, page: Number(url.match(/-p(\d+)(?=\.[a-z]+$)/i)?.[1] ?? Number.NaN) }))
            .sort((a, b) => (Number.isNaN(a.page) || Number.isNaN(b.page) ? a.index - b.index : a.page - b.page))
            .map(entry => entry.url);
        if (ordered.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return ordered;
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
