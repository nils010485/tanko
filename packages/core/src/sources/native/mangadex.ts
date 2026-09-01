/**
 * Native MangaDex connector: live API search + chapter lists + at-home pages.
 * The legacy connector relies on a stale static catalog snapshot
 * (websites.hakuneko.download/mangadex.json) which misses recent series;
 * this adapter talks to https://api.mangadex.org directly and shadows the
 * legacy connector (same id, registered first in the registry).
 */

import { randomUserAgent, retryAfterMs } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const API = 'https://api.mangadex.org';
const UA = randomUserAgent();
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];

/** Subset of the MangaDex v5 JSON:API shapes Tanko reads. */
interface MangadexLocalizedString {
    [language: string]: string | undefined;
}
interface MangadexMangaAttributes {
    title?: MangadexLocalizedString;
    altTitles?: MangadexLocalizedString[];
    availableTranslatedLanguages?: string[];
}
interface MangadexChapterAttributes {
    chapter?: string;
    title?: string;
    volume?: string;
    translatedLanguage?: string;
    externalUrl?: string;
}
interface MangadexEntity<A> {
    id: string;
    attributes?: A;
    relationships?: Array<{ type: string; attributes?: { fileName?: string } }>;
}
interface MangadexListResponse<A> {
    data?: Array<MangadexEntity<A>>;
}
interface MangadexAtHomeResponse {
    baseUrl?: string;
    chapter?: { hash?: string; data?: string[]; dataSaver?: string[] };
}

export class MangaDexConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangadex';
    readonly label = 'MangaDex';
    readonly tags = ['manga', 'multi-lingual', 'high-quality'];
    readonly url = 'https://mangadex.org';

    private lastRequestAt = 0;

    async initialize(): Promise<void> {
        // stateless API, nothing to warm up
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = this._apiUrl('/manga');
        url.searchParams.set('title', query);
        url.searchParams.set('limit', '10');
        url.searchParams.set('order[relevance]', 'desc');
        url.searchParams.append('includes[]', 'cover_art');
        const json = await this._fetch<MangadexListResponse<MangadexMangaAttributes>>(url);
        // one entry per usable title: scanlation names often live in altTitles
        // ("Damn Reincarnation" vs official "My Blasted Reincarnated Life")
        const results: MangaInfo[] = [];
        for (const manga of json.data || []) {
            const attributes = manga.attributes || {};
            const titles = [...new Set([this._pickTitle(attributes), ...this._altTitles(attributes)].filter(Boolean))];
            for (const title of titles) {
                results.push({
                    id: manga.id,
                    title,
                    url: `${this.url}/title/${manga.id}`,
                    thumbnail: this._coverUrl(manga),
                    languages: attributes.availableTranslatedLanguages?.filter(Boolean)
                });
            }
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>(); // language+chapter duplicates across scanlation groups
        for (let offset = 0; ; offset += 100) {
            const url = this._apiUrl('/chapter');
            url.searchParams.set('manga', manga.id);
            url.searchParams.set('limit', '100');
            url.searchParams.set('offset', String(offset));
            url.searchParams.set('order[chapter]', 'asc');
            url.searchParams.set('includeFutureUpdates', '0');
            const json = await this._fetch<MangadexListResponse<MangadexChapterAttributes>>(url);
            const data = json.data || [];
            for (const item of data) {
                const attributes = item.attributes || {};
                if (attributes.externalUrl) {
                    continue; // chapters hosted elsewhere are not downloadable
                }
                const chapter = attributes.chapter || '';
                const language = attributes.translatedLanguage || undefined;
                // dedupe on language+number (NOT title: scanlation groups name
                // the same chapter differently) — titled chapters without a
                // number (oneshots, extras) dedupe on their title instead
                const key = chapter ? `${language}:c${chapter}` : `${language}:t:${attributes.title || item.id}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                chapters.push({
                    id: item.id,
                    title: this._chapterTitle(attributes),
                    language
                });
            }
            if (data.length < 100) {
                break;
            }
        }
        if (chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on MangaDex`, this.id);
        }
        return chapters;
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        // at-home server URLs are short-lived: resolve right before downloading
        const json = await this._fetch<MangadexAtHomeResponse>(new URL(`/at-home/server/${chapter.id}`, API));
        const baseUrl = json.baseUrl;
        const chapterData = json.chapter || {};
        const hash = chapterData.hash;
        const files: string[] = chapterData.dataSaver || chapterData.data || [];
        const quality = chapterData.dataSaver ? 'data-saver' : 'data';
        if (!baseUrl || !hash || files.length === 0) {
            throw new SourceError(`No pages for chapter ${chapter.id} on MangaDex`, this.id);
        }
        return files.map(file => `${baseUrl}/${quality}/${hash}/${file}`);
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const response = await fetch(`${API}/manga?limit=1`, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(15000)
            });
            return { ok: response.ok, latencyMs: Date.now() - startedAt, error: response.ok ? undefined : `HTTP ${response.status}` };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    /** API endpoint with the shared content-rating filter. */
    private _apiUrl(path: string): URL {
        const url = new URL(path, API);
        for (const rating of CONTENT_RATINGS) {
            url.searchParams.append('contentRating[]', rating);
        }
        return url;
    }

    /** English title first, then romanized, then any title/alt-title. */
    private _pickTitle(attributes: MangadexMangaAttributes): string {
        const title = attributes.title || {};
        if (title.en) {
            return title.en;
        }
        const first = Object.values(title)[0];
        if (typeof first === 'string' && first) {
            return first;
        }
        for (const alt of attributes.altTitles || []) {
            if (alt.en) {
                return alt.en;
            }
        }
        return '';
    }

    /** English and romanized alt-titles (where scanlation names usually live). */
    private _altTitles(attributes: MangadexMangaAttributes): string[] {
        const titles: string[] = [];
        for (const alt of attributes.altTitles || []) {
            for (const key of ['en', 'ja-ro', 'ko-ro', 'zh-ro']) {
                if (typeof alt[key] === 'string' && alt[key]) {
                    titles.push(alt[key]);
                }
            }
        }
        return titles;
    }

    private _coverUrl(manga: MangadexEntity<MangadexMangaAttributes>): string | undefined {
        const relation = (manga.relationships || []).find(item => item.type === 'cover_art');
        const fileName = relation?.attributes?.fileName;
        return fileName ? `https://uploads.mangadex.org/covers/${manga.id}/${fileName}.256.jpg` : undefined;
    }

    /** "Vol.03 Ch.0012 - Title" — the number parser extracts volume/chapter markers. */
    private _chapterTitle(attributes: MangadexChapterAttributes): string {
        let title = '';
        if (attributes.volume) {
            title += `Vol.${attributes.volume}`;
        }
        if (attributes.chapter) {
            title += ` Ch.${attributes.chapter}`;
        }
        if (attributes.title) {
            title += `${title ? ' - ' : ''}${attributes.title}`;
        }
        return title || `Chapter ${attributes.chapter || '?'}`;
    }

    /** ~4 req/s to stay well under the public API rate limit. */
    private async _throttle(): Promise<void> {
        const wait = this.lastRequestAt + 250 - Date.now();
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait));
        }
        this.lastRequestAt = Date.now();
    }

    private async _fetch<T>(url: URL, attempt = 0): Promise<T> {
        await this._throttle();
        let retryAfter: number | undefined;
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': UA, Accept: 'application/json' },
                signal: AbortSignal.timeout(30000)
            });
            if (response.status === 429 || response.status >= 500) {
                // honor the server's Retry-After hint when it sent one
                retryAfter = retryAfterMs(response);
                throw new SourceError(`HTTP ${response.status}`, this.id);
            }
            if (!response.ok) {
                throw new SourceError(`GET ${url.pathname} returned ${response.status}`, this.id);
            }
            return await response.json();
        } catch (error) {
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, retryAfter ?? 2000 * (attempt + 1)));
                return this._fetch(url, attempt + 1);
            }
            throw error instanceof SourceError ? error : new SourceError(`GET ${url.pathname} failed`, this.id, error);
        }
    }
}
