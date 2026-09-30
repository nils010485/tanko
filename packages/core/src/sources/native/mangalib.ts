/**
 * Native MangaLIB (lib.social family, Site-Id 1) connector.
 *
 * The historical domain mangalib.me is geoblocked from some IPs (DDoS-Guard
 * 1020); the unified JSON API api.cdnlibs.org is reachable and used here.
 * Page images live on img2.imglib.info and REQUIRE
 * Referer: https://mangalib.org/ (403 without) hence fetchPageImage().
 *
 * Chain: GET /manga?q= (search) -> GET /manga/<slug>/chapters ->
 * GET /manga/<slug>/chapter?volume=<v>&number=<n>[&branch_id=<id>] ->
 * image server https://img2.imglib.info + page.url.
 */

import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { SourceError } from '../types.js';
import { checkHealthViaProbe, fetchJson, fetchRefererImage, noPagesError } from './http.js';

const API = 'https://api.cdnlibs.org/api';
const IMAGE_SERVER = 'https://img2.imglib.info';
const REFERER = 'https://mangalib.org/';

interface LibCover {
    thumbnail?: string;
    default?: string;
}

interface LibManga {
    slug?: string;
    name?: string;
    rus_name?: string;
    eng_name?: string;
    cover?: LibCover;
}

interface LibChapterBranch {
    id?: number;
    branch_id?: number | null;
}

interface LibChapter {
    volume?: string;
    number?: string;
    name?: string;
    branches?: LibChapterBranch[];
}

interface LibPage {
    url?: string;
}

interface LibListResponse {
    data?: LibManga[];
}

interface LibChaptersResponse {
    data?: LibChapter[];
}

interface LibPagesResponse {
    data?: { pages?: LibPage[] };
}

export class MangalibConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangalib';
    readonly label = 'MangaLIB';
    readonly tags = ['manga', 'russian'];
    readonly url = 'https://mangalib.org';

    async initialize(): Promise<void> {}

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = new URL(`${API}/manga`);
        url.searchParams.set('limit', '20');
        url.searchParams.set('offset', '0');
        url.searchParams.set('q', query.trim());
        const response = await fetchJson<LibListResponse>(url, { id: this.id, hostname: 'api.cdnlibs.org', label: this.label, headers: { 'Site-Id': '1' } });
        const results: MangaInfo[] = [];
        for (const item of response.data || []) {
            if (!item.slug) {
                continue;
            }
            const title = item.rus_name || item.eng_name || item.name || item.slug;
            results.push({
                id: item.slug,
                title,
                url: `${API}/manga/${item.slug}`,
                thumbnail: item.cover?.thumbnail || item.cover?.default || undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const slug = manga.id.replace(/^.*\/manga\//, '');
        const response = await fetchJson<LibChaptersResponse>(`${API}/manga/${slug}/chapters`, {
            id: this.id,
            hostname: 'api.cdnlibs.org',
            label: this.label,
            headers: { 'Site-Id': '1' }
        });
        const chapters: ChapterInfo[] = [];
        for (const chapter of response.data || []) {
            if (!chapter.volume || !chapter.number) {
                continue;
            }
            const branch = chapter.branches?.[0]?.id;
            const label = chapter.name?.trim() || `Глава ${chapter.number}`;
            const title = `Том ${chapter.volume} ${label}`;
            chapters.push({
                id: `v=${chapter.volume};n=${chapter.number};b=${branch ?? ''}`,
                title,
                url: `${API}/manga/${slug}/chapter?volume=${encodeURIComponent(chapter.volume)}&number=${encodeURIComponent(chapter.number)}${branch ? `&branch_id=${branch}` : ''}`,
                language: 'ru'
            });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre trouvé pour "${manga.title}" sur ${this.label} (licence purgée ?)`, this.id);
        }
        // API returns oldest first already; keep as-is
        return chapters;
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const slug = manga.id.replace(/^.*\/manga\//, '');
        const volume = chapter.id.match(/v=([^;]*)/)?.[1] || '';
        const number = chapter.id.match(/n=([^;]*)/)?.[1] || '';
        const branch = chapter.id.match(/b=([^;]*)/)?.[1] || '';
        const url = new URL(`${API}/manga/${slug}/chapter`);
        url.searchParams.set('volume', volume);
        url.searchParams.set('number', number);
        if (branch) {
            url.searchParams.set('branch_id', branch);
        }
        const response = await fetchJson<LibPagesResponse>(url, { id: this.id, hostname: 'api.cdnlibs.org', label: this.label, headers: { 'Site-Id': '1' } });
        const pages = (response.data?.pages || []).map(page => (page.url ? IMAGE_SERVER + page.url.replace(/^\/+/, '/') : '')).filter(url => !!url);
        if (pages.length === 0) {
            throw noPagesError(chapter, this);
        }
        return pages;
    }

    /** img2.imglib.info rejects requests without Referer https://mangalib.org/. */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        return fetchRefererImage(url, {
            id: this.id,
            referer: REFERER,
            accept: 'image/*,*/*',
            error: (status, hostname) => `HTTP ${status} on ${hostname}`
        });
    }

    async checkHealth(): Promise<HealthResult> {
        return checkHealthViaProbe(async () => {
            const url = new URL(`${API}/manga`);
            url.searchParams.set('limit', '20');
            url.searchParams.set('offset', '0');
            const response = await fetchJson<LibListResponse>(url, {
                id: this.id,
                hostname: 'api.cdnlibs.org',
                label: this.label,
                headers: { 'Site-Id': '1' }
            });
            return { ok: (response.data || []).length > 0, error: 'Catalogue vide (API modifiée ?)' };
        });
    }
}
