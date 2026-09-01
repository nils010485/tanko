/**
 * Native connector for the "comici" platform (comici.jp white-label viewer):
 * bigcomics.jp, takecomic.jp (ex-Takeshobo webzines), kimicomi.com
 * (ex-Comic Valkyrie reader).
 *
 * LIMITATION (scramble): every page image is served puzzle-scrambled with a
 * per-page 4x4 permutation (`scramble` array in the contentsInfo response).
 * This connector deliberately does NOT descramble: pages are returned as-is,
 * i.e. tiles are visually shuffled. A client-side 4x4 descrambler (canvas,
 * tiles floor(w/4) x floor(h/4)) is required for readable pages.
 *
 * LIMITATION (signed URLs): page images live on a CloudFront viewer host with
 * signed URLs (~30 min expiry, Expires/Signature/Key-Pair-Id) — always call
 * getPages() again before downloading; and they REQUIRE Referer: {base}/
 * (403 without) hence fetchPageImage().
 *
 * Chain: /series/list/up/<page> -> /series/<hash>/new -> viewerId via
 * GET /episodes/<hash>?_rsc=1 (header RSC: 1, only emitted when the anonymous
 * user has access: trial/free) -> /api/book/contentsInfo.
 */

import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { absoluteUrl } from './http.js';

export interface ComiciOptions {
    id: string;
    label: string;
    base: string;
    tags?: string[];
}

interface ComiciPage {
    imageUrl?: string;
    sort?: number;
}

interface ContentsInfo {
    totalPages?: number;
    result?: ComiciPage[];
}

export class ComiciConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url: string;

    private readonly base: string;

    constructor(options: ComiciOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.base = options.base.replace(/\/$/, '');
        this.url = this.base;
    }

    async initialize(): Promise<void> {}

    private async _getText(url: string, headers: Record<string, string> = {}): Promise<string> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'text/html,application/xhtml+xml,*/*', ...headers },
            redirect: 'follow'
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, this.id);
        }
        return response.text();
    }

    private async _getJson(url: string): Promise<unknown> {
        try {
            return JSON.parse(await this._getText(url, { accept: 'application/json' }));
        } catch (error) {
            throw new SourceError(`Réponse JSON invalide sur ${this.label}: ${errorMessage(error)}`, this.id);
        }
    }

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim().toLowerCase();
        const seen = new Set<string>();
        const results: MangaInfo[] = [];
        for (let page = 1; page <= 100; page++) {
            const html = await this._getText(`${this.base}/series/list/up/${page}`);
            const document = parseDocument(html);
            const anchors = [...document.querySelectorAll('div.series-list-item a.series-list-item-link')];
            if (anchors.length === 0) {
                break;
            }
            for (const anchor of anchors) {
                const href = this._absolute(anchor.getAttribute('href'));
                if (!href || seen.has(href)) {
                    continue;
                }
                seen.add(href);
                const title =
                    anchor.querySelector("span[data-e2e='sliTitle']")?.textContent?.replace(/\s+/g, ' ').trim() ||
                    anchor.querySelector('img')?.getAttribute('alt')?.trim() ||
                    '';
                if (!title || (needle && !title.toLowerCase().includes(needle))) {
                    continue;
                }
                results.push({
                    id: href,
                    title,
                    url: href,
                    thumbnail: anchor.querySelector('img')?.getAttribute('src') || undefined
                });
            }
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll("div.series-eplist-item a.series-eplist-item-link[href^='/episodes/']")]) {
            const href = this._absolute(anchor.getAttribute('href'));
            if (!href) {
                continue;
            }
            const title =
                anchor.querySelector('.series-eplist-item-h-text')?.textContent?.replace(/\s+/g, ' ').trim() ||
                anchor.querySelector('img')?.getAttribute('alt')?.trim() ||
                anchor.textContent?.replace(/\s+/g, ' ').trim() ||
                href;
            chapters.push({ id: href, title, url: href });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun épisode trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // site lists newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const episodeUrl = chapter.url || chapter.id;
        const episodeHash = episodeUrl.match(/\/episodes\/([0-9a-f]+)/)?.[1];
        if (!episodeHash) {
            throw new SourceError(`URL d'épisode invalide: ${episodeUrl}`, this.id);
        }
        // RSC flight payload only carries viewerId when the anonymous user has
        // access (trial/free); paid episodes have none -> explicit error.
        const rsc = await this._getText(`${this.base}/episodes/${episodeHash}?_rsc=1`, { RSC: '1' });
        const viewerId = rsc.match(/"viewerId":"([0-9a-f]{32})"/)?.[1];
        if (!viewerId) {
            throw new SourceError(`Épisode payant ou connexion requise pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        const probe = (await this._getJson(`${this.base}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=1&page-to=1`)) as ContentsInfo;
        const totalPages = probe.totalPages || 0;
        if (totalPages < 1) {
            throw new SourceError(`Réponse contentsInfo inattendue pour "${chapter.title}" sur ${this.label}`, this.id);
        }
        const contents = (await this._getJson(
            `${this.base}/api/book/contentsInfo?user-id=&comici-viewer-id=${viewerId}&page-from=1&page-to=${totalPages}`
        )) as ContentsInfo;
        const pages = (contents.result || [])
            .slice()
            .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
            .map(page => page.imageUrl)
            .filter((url): url is string => !!url);
        if (pages.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return pages;
    }

    /** CloudFront viewer host rejects image GETs without Referer {base}/ (403). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), referer: `${this.base}/`, accept: 'image/*,*/*' }
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, this.id);
        }
        return {
            mime: response.headers.get('content-type')?.split(';')[0] || 'image/jpeg',
            data: new Uint8Array(await response.arrayBuffer())
        };
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const html = await this._getText(`${this.base}/series/list/up/1`);
            if (!html.includes('series-list-item-link')) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de séries vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
