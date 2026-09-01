/**
 * Native connector for DrakeScans (https://drakecomic.net): Next.js App
 * Router site. The comic catalogue is served by a JSON endpoint
 * (/api/series?q=&limit=), while chapter lists and reader pages are embedded
 * server-side in the RSC flight payload (self.__next_f.push) of the series
 * and chapter HTML pages. Images are plain /uploads/ URLs behind Cloudflare.
 *
 * The legacy domain drakescans.com is parked (ParkLogic) and drakescans.net
 * is an unrelated blog; the live site is drakecomic.net (drakecomic.org
 * redirects there).
 */

import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { absoluteUrl, fetchNativeText } from './http.js';

interface DrakeSeries {
    slug: string;
    title: string;
    coverImage?: string;
    type?: string;
}

interface DrakeSeriesResponse {
    data?: DrakeSeries[];
    meta?: { total?: number; page?: number; limit?: number; hasMore?: boolean };
}

interface DrakeChapter {
    id?: string;
    number?: number;
    title?: string | null;
    isLocked?: boolean;
}

interface DrakePage {
    imageUrl?: string;
}

export class DrakeScansConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'drakescans';
    readonly label = 'DrakeScans';
    readonly tags = ['manga', 'manhua', 'english'];
    readonly url = 'https://drakecomic.net';

    private readonly base = 'https://drakecomic.net';

    async initialize(): Promise<void> {}

    private _absolute(href: string | undefined | null): string | null {
        return absoluteUrl(href, this.base);
    }

    /** Fetch HTML with a browser UA; anti-bot shells render in Chromium. */
    private async _getText(url: string): Promise<string> {
        return fetchNativeText(url, { id: this.id, init: { signal: AbortSignal.timeout(30_000) } });
    }

    private async _getJson(url: string): Promise<unknown> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'application/json' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur ${new URL(url).pathname}`, this.id);
        }
        return response.json().catch(() => null);
    }

    /** Rebuild the RSC flight stream embedded in a Next.js App Router page:
     *  every self.__next_f.push([1,"<json chunk>"]) appends one raw piece. */
    private _flightData(html: string): string {
        let blob = '';
        for (const match of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
            try {
                blob += JSON.parse(`"${match[1]}"`) as string;
            } catch {
                /* skip malformed chunk */
            }
        }
        return blob;
    }

    /** Extract the JSON array that follows `key` in the flight stream using a
     *  balanced-bracket scan (string/escape aware). */
    private _arrayAfter(blob: string, key: string): unknown[] | null {
        const start = blob.indexOf(key);
        if (start < 0) {
            return null;
        }
        let depth = 0;
        let opened = false;
        let inString = false;
        let escaped = false;
        for (let i = start + key.length; i < blob.length; i++) {
            const ch = blob[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (inString) {
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
            } else if (ch === '[') {
                depth++;
                opened = true;
            } else if (ch === ']') {
                depth--;
                if (opened && depth === 0) {
                    try {
                        const parsed = JSON.parse(blob.slice(start + key.length, i + 1)) as unknown;
                        return Array.isArray(parsed) ? parsed : null;
                    } catch {
                        return null;
                    }
                }
            }
        }
        return null;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = `${this.base}/api/series?limit=100${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''}`;
        const json = (await this._getJson(url)) as DrakeSeriesResponse | null;
        const series = json?.data;
        if (!Array.isArray(series)) {
            throw new SourceError(`Réponse inattendue de l'API séries de ${this.label}`, this.id);
        }
        return series
            .filter(entry => !!entry.slug && !!entry.title)
            .map(entry => {
                // route segment literal "comic" : "manhua" donnerait une coquille sans flight data
                const href = `${this.base}/series/comic/${entry.slug}`;
                return {
                    id: href,
                    title: entry.title,
                    url: href,
                    thumbnail: this._absolute(entry.coverImage) || undefined,
                    languages: ['en']
                };
            });
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const seriesUrl = (manga.url || manga.id).replace(/\/$/, '');
        const chapters: ChapterInfo[] = [];
        const seen = new Set<number>();
        let page = 1;
        for (; page < 50; page++) {
            const html = await this._getText(page === 1 ? seriesUrl : `${seriesUrl}?page=${page}`);
            const rows = (this._arrayAfter(this._flightData(html), '"chapters":') || []) as DrakeChapter[];
            let added = 0;
            for (const row of rows) {
                if (!row || typeof row.number !== 'number' || row.isLocked || seen.has(row.number)) {
                    continue;
                }
                seen.add(row.number);
                added++;
                const name = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : `Chapter ${row.number}`;
                chapters.push({
                    id: `${seriesUrl}/chapter/${row.number}`,
                    title: name,
                    url: `${seriesUrl}/chapter/${row.number}`,
                    language: 'en'
                });
            }
            // the series page embeds at most 100 chapters per ?page=N slice
            if (added < 100) {
                break;
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters.sort((a, b) => Number(a.id.match(/chapter\/(\d+)/)?.[1] || 0) - Number(b.id.match(/chapter\/(\d+)/)?.[1] || 0));
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const html = await this._getText(chapterUrl);
        const blob = this._flightData(html);
        const pages = (this._arrayAfter(blob, '"pages":') || []) as DrakePage[];
        let images = pages.map(page => this._absolute(page?.imageUrl)).filter((src): src is string => !!src);
        if (images.length === 0) {
            images = [...blob.matchAll(/"imageUrl":"((?:[^"\\]|\\.)*)"/g)]
                .map(match => this._absolute(match[1].replace(/\\\//g, '/')))
                .filter((src): src is string => !!src);
        }
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const json = (await this._getJson(`${this.base}/api/series?limit=1`)) as DrakeSeriesResponse | null;
            const ok = Array.isArray(json?.data);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Réponse API invalide' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
