/**
 * Native MangaToon connector over the signed JSON API of
 * https://sg.mangatoon.mobi (h5 bundle secret). The signature is
 * md5(path + sorted-encoded-query + secret); the app default params
 * (_platform=web, _v=3.07.00, ...) must be part of the signed set.
 *
 * Image URLs returned by /api/cartoons/pictures point to scrambled
 * "encrypted/*.webp" files: the watermark/*.jpg twin on the same host is a
 * real JPEG, and HTTPS certificates are only valid on the dashed hosts
 * (en-c-pic.mangatoon.mobi), so URLs are normalized both ways.
 *
 * Paid episodes (is_fee) answer {"status":"error","error_code":-3001}
 * without an account: they are filtered out of the chapter list.
 */

import { createHash } from 'node:crypto';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const API = 'https://sg.mangatoon.mobi';
const SIGN_SECRET = '66c10a61bd916c23f3b33810d3785d17';
const UA = randomUserAgent();

export type MangaToonLanguage = 'en' | 'cn' | 'id' | 'vi';

export interface MangaToonOptions {
    id: string;
    label: string;
    language: MangaToonLanguage;
    tags?: string[];
}

/** Subset of the MangaToon API shapes Tanko reads. */
interface MangaToonContent {
    id?: number;
    title?: string;
    image_url?: string;
}
interface MangaToonEpisode {
    id?: number;
    title?: string;
    weight?: number;
    is_fee?: boolean;
}
interface MangaToonPicture {
    url?: string;
}
interface MangaToonResponse<T> {
    status?: string;
    error_code?: number;
    data?: T;
}

export class MangaToonConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly url = 'https://mangatoon.mobi';

    private readonly language: MangaToonLanguage;

    constructor(options: MangaToonOptions) {
        this.id = options.id;
        this.label = options.label;
        this.tags = options.tags || ['manga'];
        this.language = options.language;
    }

    async initialize(): Promise<void> {
        // stateless signed API, nothing to warm up
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const data = await this._api<MangaToonContent[]>('/api/content/list', { word: query.trim() });
        const results: MangaInfo[] = [];
        for (const item of data || []) {
            if (!item.id || !item.title) {
                continue;
            }
            results.push({
                id: String(item.id),
                title: item.title,
                thumbnail: this._decodeImageUrl(item.image_url || ''),
                languages: [this.language]
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const data = await this._api<MangaToonEpisode[]>('/api/content/episodes', { id: manga.id });
        const chapters: ChapterInfo[] = (data || [])
            .filter(episode => episode.id && !episode.is_fee) // paid -> error_code -3001 without an account
            .sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
            .map(episode => ({
                id: String(episode.id),
                title: episode.title || `Episode ${episode.weight ?? episode.id}`
            }));
        if (chapters.length === 0) {
            throw new SourceError(`No free chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters;
    }
    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const data = await this._api<MangaToonPicture[]>('/api/cartoons/pictures', {
            id: chapter.id,
            close_wait_free_tooltip: 'true'
        });
        const pages = (data || []).map(item => item.url && this._decodeImageUrl(item.url)).filter((url): url is string => !!url);
        if (pages.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return pages;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const results = await this.searchMangas('a');
            if (results.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Réponse vide (API modifiée ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    /** md5(path + sorted-encoded-params + secret) over the merged default params. */
    private _signedUrl(path: string, params: Record<string, string | number>): string {
        const merged: Record<string, string> = {
            _platform: 'web',
            _v: '3.07.00',
            _webp: 'false',
            _preference: 'girl',
            _language: this.language,
            ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]))
        };
        const keys = Object.keys(merged).sort((a, b) =>
            encodeURIComponent(a) < encodeURIComponent(b) ? -1 : encodeURIComponent(a) > encodeURIComponent(b) ? 1 : 0
        );
        const query = keys.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(merged[key])}`).join('&');
        const sign = createHash('md5')
            .update(path + query + SIGN_SECRET)
            .digest('hex');
        return `${API}${path}?sign=${sign}&${query}`;
    }

    private async _api<T>(path: string, params: Record<string, string | number>): Promise<T> {
        let response: Response;
        try {
            response = await fetch(this._signedUrl(path, params), {
                headers: { 'user-agent': UA, accept: 'application/json' },
                signal: AbortSignal.timeout(30000)
            });
        } catch (error) {
            throw new SourceError(`GET ${path} failed on ${this.label}`, this.id, error);
        }
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} on ${path} (${this.label})`, this.id);
        }
        const json = (await response.json().catch(() => undefined)) as MangaToonResponse<T> | undefined;
        if (!json || json.status === 'error') {
            const detail = json?.error_code !== undefined ? ` (error_code ${json.error_code})` : '';
            throw new SourceError(`API error on ${path}${detail}: ${this.label}`, this.id);
        }
        return json.data as T;
    }

    /** Scrambled webp -> watermark jpg twin, dashed image host, https. */
    private _decodeImageUrl(url: string): string | undefined {
        if (!url) {
            return undefined;
        }
        try {
            const parsed = new URL(url, API);
            parsed.protocol = 'https:';
            parsed.hostname = parsed.hostname.replace('.e.pic.', '-e-pic.').replace('.c.pic.', '-c-pic.');
            parsed.pathname = parsed.pathname.replace('/encrypted/', '/watermark/').replace(/\.webp$/, '.jpg');
            return parsed.href;
        } catch {
            return undefined;
        }
    }
}

export const mangatoonEn = new MangaToonConnector({ id: 'mangatoon-en', label: 'MangaToon (English)', language: 'en' });
export const mangatoonCn = new MangaToonConnector({ id: 'mangatoon-cn', label: 'MangaToon (Chinese)', language: 'cn', tags: ['manga', 'chinese'] });
export const mangatoonId = new MangaToonConnector({ id: 'mangatoon-id', label: 'MangaToon (Indonesian)', language: 'id', tags: ['manga', 'indonesian'] });
export const mangatoonVi = new MangaToonConnector({ id: 'mangatoon-vi', label: 'MangaToon (Vietnamese)', language: 'vi', tags: ['manga', 'vietnamese'] });
