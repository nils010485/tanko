/**
 * Native connector for ZeurelScan (https://www.zeurelscan.com): static Italian
 * site. Catalogue at /series (relative serie/<slug> links), chapters at
 * /serie/<slug> (/read/<slug>/<n> links), reader images in div.reader.
 * Quirk: the reader endpoint answers HTTP 400 with a fully valid body —
 * the body must be read even when !response.ok.
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, checkHealthViaSearch, fetchNativeText, lazySrc, noPagesError } from './http.js';

export class ZeurelScanConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'zeurelscan';
    readonly label = 'ZeurelScan';
    readonly tags = ['manga', 'italian'];
    private readonly base = 'https://www.zeurelscan.com';
    readonly url = this.base;

    async initialize(): Promise<void> {}

    /** The reader serves valid HTML with a fake HTTP 400 status: keep the body. */
    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, {
            id: this.id,
            headers: { 'accept-language': 'it,*;q=0.5' },
            accept: (response, body) =>
                response.ok || (response.status === 400 && body.includes('<') && (body.includes('/read/') || body.includes('serie') || body.includes('<html')))
        });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}/series`);
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        // catalogue links are relative (serie/<slug>) with no leading slash
        for (const anchor of [...document.querySelectorAll('a[href*="serie"]')] as Array<HTMLAnchorElement>) {
            const href = absoluteUrl(anchor.getAttribute('href'), `${this.base}/`);
            if (!href) {
                continue;
            }
            const path = new URL(href).pathname;
            const match = path.match(/^\/serie\/([^/]+)\/?$/);
            if (!match) {
                continue;
            }
            const slug = match[1];
            if (seen.has(slug)) {
                continue;
            }
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title || (needle && !title.toLowerCase().includes(needle) && !slug.includes(needle))) {
                continue;
            }
            seen.add(slug);
            const url = `${this.base}/serie/${slug}`;
            results.push({
                id: url,
                title: title === slug ? title.replace(/-/g, ' ') : title,
                url,
                thumbnail: lazySrc(anchor.querySelector('img'))
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || manga.id);
        const document = parseDocument(html);
        const slug = new URL(manga.url || manga.id).pathname.match(/\/serie\/([^/]+)/)?.[1];
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('a[href*="/read/"]')] as Array<HTMLAnchorElement>) {
            const href = absoluteUrl(anchor.getAttribute('href'), `${this.base}/`);
            if (!href) {
                continue;
            }
            const match = new URL(href).pathname.match(/\/read\/([^/]+)\/(\d+)\/?$/);
            if (!match || (slug && match[1] !== slug)) {
                continue;
            }
            if (seen.has(href)) {
                continue;
            }
            seen.add(href);
            const text = (anchor.textContent || anchor.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
            // some anchors are generic nav buttons ("Continua a leggere") -> fall back to the URL number
            const title = !text || /continua a leggere|leggi di/i.test(text) ? `Capitolo ${match[2]}` : text;
            chapters.push({ id: href, title, url: href });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // natural order is lexicographic (1, 10, 100...) -> sort numerically
        return chapters.sort((a, b) => {
            const na = Number.parseFloat(a.id.match(/\/read\/[^/]+\/(\d+)/)?.[1] || '0');
            const nb = Number.parseFloat(b.id.match(/\/read\/[^/]+\/(\d+)/)?.[1] || '0');
            return na - nb;
        });
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('div.reader img[src], .reader-container img[src]')]
            .map(img => img.getAttribute('src'))
            .filter((src): src is string => !!src && src.startsWith('http') && src.includes('/immagini/'))
            .map(src => absoluteUrl(src, `${this.base}/`))
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw noPagesError(chapter, this);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaSearch(this, '', 'Catalogue vide (site modifié ?)');
    }
}
