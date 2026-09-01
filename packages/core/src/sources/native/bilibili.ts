/**
 * Native connector for Bilibili Manhua (manga.bilibili.com; legacy tanko id
 * "neteasecomic" for continuity): the twirp JSON API answers "code 99" risk
 * control to any non-browser client, so search falls back to the server
 * rendered homepage and chapters/reader go through headless Chromium. Chapter
 * image URLs are short-lived signed CDN links captured from the rendered
 * reader DOM (best effort — the official flow signs urls per session).
 */

import { parseDocument } from '../../shims/dom.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { fetchNativeText } from './http.js';

export class BilibiliManhuaConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'neteasecomic';
    readonly label = 'Bilibili Manhua';
    readonly tags = ['manga', 'chinese'];
    readonly url = 'https://manga.bilibili.com';

    private readonly base = 'https://manga.bilibili.com';

    async initialize(): Promise<void> {}

    private async _getText(url: string, timeoutMs = 45_000): Promise<string> {
        return fetchNativeText(url, {
            id: this.id,
            headers: { accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
            minBytes: 20_000,
            timeoutMs,
            init: { signal: AbortSignal.timeout(30_000) },
            renderError: 'Page Bilibili non rendue (rendu navigateur requis)'
        });
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const html = await this._getText(`${this.base}/`);
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results = new Map<string, MangaInfo>();
        for (const anchor of [...document.querySelectorAll('a[href*="/detail/mc"]')]) {
            const href = anchor.getAttribute('href') || '';
            const match = href.match(/\/detail\/(mc\d+)/);
            if (!match) {
                continue;
            }
            const image = anchor.querySelector('img');
            const title = (anchor.getAttribute('title') || image?.getAttribute('alt') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title || results.has(match[1])) {
                continue;
            }
            if (needle && !title.toLowerCase().includes(needle)) {
                continue;
            }
            results.set(match[1], {
                id: match[1],
                title,
                url: `${this.base}/detail/${match[1]}`,
                thumbnail: image?.getAttribute('src') || image?.getAttribute('data-src') || undefined,
                languages: ['zh']
            });
        }
        return [...results.values()];
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const html = await this._getText(manga.url || `${this.base}/detail/${manga.id}`);
        const document = parseDocument(html);
        const chapters = new Map<string, ChapterInfo>();
        for (const anchor of [...document.querySelectorAll(`a[href*="/${manga.id}/"]`)]) {
            const href = anchor.getAttribute('href') || '';
            const match = href.match(/\/mc\d+\/(\d+)/);
            if (!match) {
                continue;
            }
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim() || `第${match[1]}话`;
            if (!chapters.has(match[1])) {
                chapters.set(match[1], { id: match[1], title, url: `${this.base}/${manga.id}/${match[1]}`, language: 'zh' });
            }
        }
        if (chapters.size === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return [...chapters.values()].sort((a, b) => Number(a.id) - Number(b.id));
    }

    /** Best effort: signed reader images captured from the rendered reader DOM. */
    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const readerUrl = chapter.url || `${this.base}/${manga.id}/${chapter.id}`;
        const html = await this._getText(readerUrl);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('img')]
            .map(img => (img.getAttribute('src') || img.getAttribute('data-src') || '').trim())
            .filter(src => src.startsWith('http') && /hdslb\.com|manga.*\.(jpg|jpeg|png|webp)|bfs\/manga/.test(src))
            .map(src => new URL(src, this.base).href);
        const unique = [...new Set(images)];
        if (unique.length === 0) {
            throw new SourceError(`Pages non capturées pour "${chapter.title}" (lecteur signé côté client)`, this.id);
        }
        return unique;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const mangas = await this.searchMangas('');
            if (mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Catalogue vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
