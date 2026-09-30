/**
 * Native connector for WEBTOON Thai (https://www.webtoons.com/th/): search via
 * GET /th/search?keyword=, chapter list from viewer links with ?page=N
 * pagination, reader images as img[data-url] (raw HTML, no JS needed).
 * Naver CDN images require Referer: https://www.webtoons.com/ (403 Akamai
 * otherwise) -> fetchPageImage.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, checkHealthViaSearch, fetchNativeText, fetchRefererImage, noPagesError } from './http.js';

export class LineWebtoonConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'linewebtoon-th';
    readonly label = 'WEBTOON (Thai)';
    readonly tags = ['manga', 'webtoon', 'thai'];
    private readonly language = 'th';
    private readonly base = `https://www.webtoons.com/${this.language}/`;
    /** Images are served by webtoon-phinf.pstatic.net; the CDN checks the site Referer. */
    private readonly refererBase = 'https://www.webtoons.com/';
    readonly url = this.base;

    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, headers: { 'accept-language': 'th,*;q=0.5' } });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const needle = query.trim();
        if (!needle) {
            throw new SourceError('Recherche vide non supportée par WEBTOON', this.id);
        }
        const html = await this._getText(`${this.base}search?keyword=${encodeURIComponent(needle)}`);
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [
            ...document.querySelectorAll(`a[href*="/${this.language}/"][href*="list?title_no="], a[href*="list?title_no="]`)
        ] as Array<HTMLAnchorElement>) {
            const href = absoluteUrl(anchor.getAttribute('href'), this.base);
            if (!href) {
                continue;
            }
            const url = new URL(href);
            const titleNo = url.searchParams.get('title_no');
            if (!titleNo || seen.has(titleNo)) {
                continue;
            }
            const title =
                anchor.getAttribute('title') || anchor.querySelector('strong.title, .subj, .info span, h3, h6')?.textContent || anchor.textContent || '';
            const clean = title.replace(/\s+/g, ' ').trim();
            if (!clean) {
                continue;
            }
            seen.add(titleNo);
            // canonical series URL: /{lang}/{genre}/{slug}/list?title_no={n}
            const listPath = url.pathname.endsWith('/list') ? url.pathname : `${url.pathname.replace(/\/$/, '')}/list`;
            const seriesUrl = `${url.origin}${listPath}?title_no=${titleNo}`;
            results.push({
                id: seriesUrl,
                title: clean,
                url: seriesUrl,
                thumbnail: anchor.querySelector('img')?.getAttribute('src') || undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = new URL(manga.url || manga.id);
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (let page = 1; page <= 999; page++) {
            seriesUrl.searchParams.set('page', String(page));
            const html = await this._getText(seriesUrl.href);
            const document = parseDocument(html);
            let added = 0;
            // current markup: episode cards link to .../viewer?title_no=N&episode_no=M
            for (const anchor of [...document.querySelectorAll('a[href*="viewer?"]')] as Array<HTMLAnchorElement>) {
                const href = absoluteUrl(anchor.getAttribute('href'), this.base);
                if (!href) {
                    continue;
                }
                const url = new URL(href);
                const episodeNo = url.searchParams.get('episode_no');
                if (!episodeNo || seen.has(episodeNo)) {
                    continue;
                }
                seen.add(episodeNo);
                added++;
                const label = anchor.querySelector('.tx, .sub_title, .subj')?.textContent?.replace(/\s+/g, ' ').trim();
                chapters.push({
                    id: href,
                    title: label ? `#${episodeNo} ${label.replace(/^#\d+\s*/, '')}` : `Episode ${episodeNo}`,
                    url: href
                });
            }
            if (added === 0) {
                break;
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun épisode trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // pages are newest-first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('img[data-url]')]
            .map(img => img.getAttribute('data-url'))
            .filter((src): src is string => !!src && !src.startsWith('data:'))
            .map(src => absoluteUrl(src, this.base))
            .filter((src): src is string => !!src);
        const unique = [...new Set(images)];
        if (unique.length === 0) {
            throw noPagesError(chapter, this);
        }
        return unique;
    }

    /** Naver CDN images reject requests without the site Referer (403 Akamai). */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        return fetchRefererImage(url, {
            id: this.id,
            referer: this.refererBase,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            error: (status, hostname) => `HTTP ${status} sur l'image CDN ${hostname}`
        });
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaSearch(this, 'love', 'Recherche vide (site modifié ?)');
    }
}
