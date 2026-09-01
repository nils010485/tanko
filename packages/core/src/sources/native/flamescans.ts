/**
 * Native connector for FlameScans (id 'flamescans-org'): the historical
 * flamescans.org is a JavaScript challenge shell; the live reader is
 * flamecomics.xyz ("Flame Comics"), a Next.js Pages Router site with fully
 * SSG pages. Every page embeds a __NEXT_DATA__ JSON blob:
 *  - catalogue : /browse  -> props.pageProps.series[]
 *  - chapters  : /series/{id} -> props.pageProps.chapters[] (token per chapter)
 *  - pages     : /series/{id}/{token} -> props.pageProps.chapter.images{}
 * Images are plain CDN urls (cdn.flamecomics.xyz, no Referer required).
 */

import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

interface FlameSeries {
    series_id: number;
    title: string;
    cover?: string;
    type?: string;
}

interface FlameChapter {
    chapter_id: number;
    chapter: string;
    title?: string | null;
    token: string;
}

interface FlamePage {
    name?: string;
}

interface FlameNextData {
    props?: {
        pageProps?: {
            series?: FlameSeries[];
            chapters?: FlameChapter[];
            token?: string;
            chapter?: {
                series_id?: number;
                images?: Record<string, FlamePage>;
            };
        };
    };
}

export class FlameScansConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'flamescans-org';
    readonly label = 'FlameScans';
    readonly tags = ['manga', 'manhwa', 'english'];
    readonly url = 'https://flamecomics.xyz';

    private readonly base = 'https://flamecomics.xyz';
    private readonly cdn = 'https://cdn.flamecomics.xyz';

    async initialize(): Promise<void> {}

    private _headers(): Record<string, string> {
        return {
            'user-agent': randomUserAgent(),
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9'
        };
    }

    private async _getText(url: string): Promise<string> {
        const response = await fetch(url, { headers: this._headers(), redirect: 'follow', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur ${new URL(url).pathname}`, this.id);
        }
        return response.text();
    }

    private async _getNextData(url: string): Promise<FlameNextData | null> {
        const html = await this._getText(url);
        const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s)?.[1];
        if (!raw) {
            throw new SourceError(`__NEXT_DATA__ introuvable sur ${new URL(url).pathname}`, this.id);
        }
        return JSON.parse(raw) as FlameNextData;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const data = await this._getNextData(`${this.base}/browse`);
        const series = data?.props?.pageProps?.series;
        if (!Array.isArray(series)) {
            throw new SourceError(`Catalogue introuvable sur ${this.label}`, this.id);
        }
        const needle = query.trim().toLowerCase();
        return series
            .filter(entry => !!entry.series_id && !!entry.title)
            .filter(entry => !needle || entry.title.toLowerCase().includes(needle))
            .map(entry => ({
                id: String(entry.series_id),
                title: entry.title,
                url: `${this.base}/series/${entry.series_id}`,
                thumbnail: entry.cover ? `${this.cdn}/uploads/images/series/${entry.series_id}/${entry.cover}` : undefined,
                languages: ['en']
            }));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const data = await this._getNextData(manga.url || `${this.base}/series/${manga.id}`);
        const chapters = data?.props?.pageProps?.chapters;
        if (!Array.isArray(chapters) || chapters.length === 0) {
            throw new SourceError(`No chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        // chapters are listed newest first -> chronological
        return chapters
            .slice()
            .reverse()
            .filter(chapter => !!chapter.token)
            .map(chapter => {
                const number = Number.parseFloat(chapter.chapter) || chapter.chapter;
                const name = chapter.title?.trim() ? `Chapter ${number} - ${chapter.title.trim()}` : `Chapter ${number}`;
                const url = `${this.base}/series/${manga.id}/${chapter.token}`;
                return { id: url, title: name, url, language: 'en' };
            });
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const chapterUrl = chapter.url || chapter.id;
        const data = await this._getNextData(chapterUrl);
        const reader = data?.props?.pageProps?.chapter;
        const token = data?.props?.pageProps?.token || chapterUrl.split('/').pop();
        const seriesId = reader?.series_id || Number(manga.id);
        const images = Object.entries(reader?.images || {})
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([, page]) => page?.name)
            .filter((name): name is string => !!name)
            .map(name => `${this.cdn}/uploads/images/series/${seriesId}/${token}/${name}`);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const data = await this._getNextData(`${this.base}/browse`);
            const ok = Array.isArray(data?.props?.pageProps?.series);
            return { ok, latencyMs: Date.now() - startedAt, error: ok ? undefined : 'Catalogue __NEXT_DATA__ absent' };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
