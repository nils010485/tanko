/**
 * Native connector for KuManga (kumanga.com, spanish): the domain dances a
 * 307 ?__r= cookie loop on every request (a cookie jar is mandatory), series
 * and chapter lists are static HTML, but the reader sits behind a Cloudflare
 * challenge and Alpine.js hydration -> browser rendering. Reader images ride
 * the /img.php?src=<HEX> proxy: the hex decodes to the real eve.manga.tel CDN
 * url, which serves images without cookies.
 */

import { browserEnabled, getPageHTML, isAntiBotShell } from '../../shims/browser.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { absoluteUrl } from './http.js';

export class KuMangaConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'kumanga';
    readonly label = 'KuManga';
    readonly tags = ['manga', 'spanish'];
    readonly url = 'https://www.kumanga.com';

    private readonly base = 'https://www.kumanga.com';
    private readonly jar = new Map<string, string>();

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, `${this.base}/`);
    }

    private _cookieHeader(): string {
        return [...this.jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    /** Manual redirect walk storing cookies: the ?__r= loop never ends otherwise. */
    private async _get(url: string, hops = 6): Promise<{ status: number; body: string; location: string | null }> {
        let current = url;
        for (let hop = 0; hop <= hops; hop++) {
            const response = await fetch(current, {
                redirect: 'manual',
                headers: {
                    'user-agent': randomUserAgent(),
                    accept: 'text/html,application/xhtml+xml',
                    'accept-language': 'es,en;q=0.5',
                    ...(this.jar.size > 0 ? { cookie: this._cookieHeader() } : {})
                },
                signal: AbortSignal.timeout(30_000)
            });
            for (const cookie of response.headers.getSetCookie?.() || []) {
                const [pair] = cookie.split(';');
                const eq = pair.indexOf('=');
                if (eq > 0) {
                    this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
                }
            }
            const location = response.headers.get('location');
            if (response.status >= 300 && response.status < 400 && location) {
                current = this._absolute(location) || current;
                continue;
            }
            return { status: response.status, body: await response.text().catch(() => ''), location: null };
        }
        return { status: 0, body: '', location: null };
    }

    private async _getText(url: string): Promise<string> {
        const { status, body } = await this._get(url);
        if (status === 200 && !isAntiBotShell(body, status)) {
            return body;
        }
        if (browserEnabled()) {
            const rendered = await getPageHTML(url, { timeoutMs: 45_000 }).catch(() => undefined);
            if (rendered?.html && !isAntiBotShell(rendered.html)) {
                return rendered.html;
            }
        }
        throw new SourceError(`Page inaccessible (HTTP ${status}) sur ${new URL(url).hostname}`, this.id);
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}/`);
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results = new Map<string, MangaInfo>();
        for (const anchor of [...document.querySelectorAll('a[href*="manga/"]')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const match = href?.match(/\/manga\/(\d+)\/([a-z0-9-]+)/);
            if (!href || !match) {
                continue;
            }
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim() || match[2].replace(/-/g, ' ');
            if (!title || results.has(href)) {
                continue;
            }
            if (needle && !title.toLowerCase().includes(needle)) {
                continue;
            }
            const image = anchor.querySelector('img');
            results.set(href, {
                id: `manga/${match[1]}/${match[2]}`,
                title: title.replace(/\b\w/g, c => c.toUpperCase()),
                url: href,
                thumbnail: image?.getAttribute('data-src') || image?.getAttribute('src') || undefined
            });
        }
        return [...results.values()];
    }

    private static _chapterNumber(chapterId: string): number {
        return Number(chapterId.match(/capitulo\/(\d+)/)?.[1] || 0);
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(`${this.base}/${manga.id}`);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('a.media-chapter__link, a[href*="/capitulo/"]')]) {
            const href = this._absolute(anchor.getAttribute('href'));
            const match = href?.match(/\/manga\/(\d+)\/capitulo\/(\d+)/);
            if (!href || !match) {
                continue;
            }
            const number = KuMangaConnector._chapterNumber(href);
            if (number > 0 && !chapters.some(chapter => chapter.id === href)) {
                chapters.push({ id: href, title: `Capítulo ${number}`, url: href, language: 'es' });
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters.sort((a, b) => KuMangaConnector._chapterNumber(a.id) - KuMangaConnector._chapterNumber(b.id));
    }

    /** /capitulo/<n> 302s to /manga/c/<chapterId>; the reader is /manga/leer/<id>. */
    private async _resolveReaderUrl(chapterUrl: string): Promise<string> {
        const { location } = await this._get(chapterUrl);
        if (location) {
            return location.replace('/manga/c/', '/manga/leer/');
        }
        return chapterUrl;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const readerUrl = await this._resolveReaderUrl(chapter.url || chapter.id);
        const html = await this._getText(readerUrl);
        const document = parseDocument(html);
        const images: string[] = [];
        for (const img of [...document.querySelectorAll('img[data-src^="/img.php?src="]')]) {
            const hex = img.getAttribute('data-src')?.match(/src=([0-9A-Fa-f]+)/)?.[1];
            if (!hex || hex.length % 2 !== 0) {
                continue;
            }
            try {
                const decoded = Buffer.from(hex, 'hex').toString('utf8');
                if (decoded.startsWith('http')) {
                    images.push(decoded);
                }
            } catch {
                /* skip malformed hex */
            }
        }
        const unique = [...new Set(images)];
        if (unique.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return unique;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const html = await this._getText(`${this.base}/`);
            if (!html.includes('manga/')) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Catalogue vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
