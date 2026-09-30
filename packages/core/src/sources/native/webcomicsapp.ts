/**
 * Native connector for WebComics (webcomicsapp.com): Nuxt SPA where the
 * catalog and chapter list are server-rendered but the reader only mounts
 * its images after JS hydration + programmatic scrolling (lazy-load).
 */

import { browserEnabled, getBrowser } from '../../shims/browser.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { absoluteUrl, checkHealthViaSearch, fetchRefererImage, lazySrc, noPagesError } from './http.js';

export class WebComicsAppConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'webcomicsapp';
    readonly label = 'WebComics';
    readonly tags = ['webtoon', 'english'];
    private readonly base = 'https://www.webcomicsapp.com';
    readonly url = this.base;

    private async _getText(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'text/html' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur ${new URL(url).pathname}`, this.id);
        }
        return response.text();
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}/en/`);
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results = new Map<string, MangaInfo>();
        for (const anchor of [...document.querySelectorAll('a[href^="/en/comic/"]')]) {
            const href = absoluteUrl(anchor.getAttribute('href'), `${this.base}/en/`);
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title || results.has(href)) {
                continue;
            }
            if (needle && !title.toLowerCase().includes(needle)) {
                continue;
            }
            const image = anchor.querySelector('img');
            results.set(href, {
                id: href,
                title,
                url: href,
                thumbnail: lazySrc(image)
            });
        }
        return [...results.values()];
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(`${this.base}/en/chapters/${manga.id.split('/').slice(-2).join('/')}`);
        const document = parseDocument(html);
        const chapters = new Map<number, ChapterInfo>();
        for (const anchor of [...document.querySelectorAll('a[href*="/en/bl/"]')]) {
            const href = absoluteUrl(anchor.getAttribute('href'), `${this.base}/en/`);
            const match = href?.match(/\/en\/bl\/[^/]+\/(\d+)\//);
            if (!href || !match) {
                continue;
            }
            const number = Number.parseInt(match[1], 10);
            if (!chapters.has(number)) {
                chapters.set(number, { id: href, title: `Chapter ${number}`, url: href, language: 'en' });
            }
        }
        if (chapters.size === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return [...chapters.values()].sort(
            (a, b) => Number(a.id.match(/\/bl\/[^/]+\/(\d+)\//)?.[1] || 0) - Number(b.id.match(/\/bl\/[^/]+\/(\d+)\//)?.[1] || 0)
        );
    }

    /** The reader only renders its images after hydration + scrolling. */
    private async _renderScrolled(url: string, scrolls = 15): Promise<string> {
        if (!browserEnabled()) {
            throw new SourceError('Lecteur WebComics: rendu navigateur requis (non disponible)', this.id);
        }
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
            for (let i = 0; i < scrolls; i++) {
                await page.evaluate(() => window.scrollBy(0, 2500)).catch(() => undefined);
                await new Promise(resolve => setTimeout(resolve, 350));
            }
            return await page.content();
        } finally {
            await page.close().catch(() => undefined);
        }
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._renderScrolled(chapter.url || chapter.id);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('.reader-page img, img[src*="mangaina"]')]
            .map(img => (img.getAttribute('src') || '').trim())
            .filter(src => src.startsWith('http') && src.includes('mangaina'))
            .map(src => new URL(src).href);
        const unique = [...new Set(images)];
        if (unique.length === 0) {
            throw noPagesError(chapter, this);
        }
        return unique;
    }

    /** The mangaina CDN requires the site Referer. */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        return fetchRefererImage(url, {
            id: this.id,
            referer: `${this.base}/`,
            error: (status, hostname) => `HTTP ${status} on ${hostname}`
        });
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaSearch(this, '', 'Catalogue vide (site modifié ?)');
    }
}
