/**
 * Native ComicK connector (hybrid base):
 *  - metadata via https://api.comick.dev (search, covers on meo.comick.pictures)
 *    where md_images/get_images were emptied server-side;
 *  - chapters + pages via the https://comick.art mirror, whose reader HTML
 *    embeds a <script id="sv-data"> JSON with the full ordered image list;
 *  - images live on cdn1.comicknew.pictures and require
 *    Referer: https://comick.art/ (hotlink protection) -> fetchPageImage().
 *
 * dev and art catalogs diverge (slugs AND chapter hids may differ), so the
 * art comic is resolved by search and chapters come from art when possible;
 * dev chapter list is only a best-effort fallback (its reader has no images).
 */
import { browserEnabled, getPageHTML, isAntiBotShell } from '../../shims/browser.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';
import { pinToOrigin } from './http.js';

const API = 'https://api.comick.dev';
const SITE = 'https://comick.dev';
const MIRROR = 'https://comick.art';
const CHAPTER_LANG = 'en';
const UA = randomUserAgent();

/** Subset of the api.comick.dev / comick.art JSON shapes Tanko reads. */
interface DevSearchItem {
    hid?: string;
    slug?: string;
    title?: string;
    md_covers?: Array<{ b2key?: string }>;
}
interface DevChapter {
    hid?: string;
    chap?: string;
    vol?: string | null;
    title?: string | null;
    lang?: string;
    group_name?: string[];
}
interface DevChaptersResponse {
    total?: number;
    limit?: number;
    chapters?: DevChapter[];
}
interface ArtComic {
    hid?: string;
    slug?: string;
    title?: string;
}
interface ArtSearchResponse {
    data?: ArtComic[];
}
interface ArtChapterListResponse {
    data?: DevChapter[];
    pagination?: { current_page?: number; last_page?: number };
}
interface SvChapterData {
    chapter?: { images?: Array<{ url?: string }> };
}

export class ComickConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'comick';
    readonly label = 'ComicK (comick)';
    readonly tags = ['manga', 'multi-lingual'];
    readonly url = MIRROR;

    private lastRequestAt = 0;
    private readonly artComicCache = new Map<string, ArtComic>();

    async initialize(): Promise<void> {
        // stateless APIs, nothing to warm up
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const url = new URL('/v1.0/search', API);
        url.searchParams.set('q', query.trim());
        url.searchParams.set('limit', '20');
        url.searchParams.set('page', '1');
        const items = await this._fetchJson<DevSearchItem[]>(url);
        const results: MangaInfo[] = [];
        for (const item of items || []) {
            if (!item.hid || !item.title) {
                continue;
            }
            const b2key = item.md_covers?.[0]?.b2key;
            results.push({
                id: item.hid,
                title: item.title,
                url: item.slug ? `${SITE}/comic/${item.slug}` : undefined,
                thumbnail: b2key ? `https://meo.comick.pictures/${b2key}` : undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const art = await this._findArtComic(manga);
        const chapters: ChapterInfo[] = art ? await this._artChapters(art) : await this._devChapters(manga);
        if (chapters.length === 0) {
            throw new SourceError(`No ${CHAPTER_LANG} chapters found for "${manga.title}" on ${this.label}`, this.id);
        }
        return chapters.reverse(); // both APIs return newest first
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        // queue jobs carry only the chapter id (no url): the reader resolves
        // chapters by hid — slug/chap/lang in the path are decorative
        const rawUrl = chapter.url || `${MIRROR}/comic/x/${chapter.id}-chapter-x-en`;
        const html = await this._getReaderHtml(rawUrl);
        const json = html.match(/<script id="sv-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
        let images: Array<{ url?: string }> | undefined;
        try {
            images = json ? (JSON.parse(json) as SvChapterData).chapter?.images : undefined;
        } catch {
            images = undefined;
        }
        const pages = (images || []).map(image => image.url).filter((url): url is string => !!url);
        if (pages.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return pages;
    }

    /** cdn1.comicknew.pictures requires Referer: https://comick.art/
     *  and transiently rate-limits bursts (429): retry with backoff. */
    async fetchPageImage(url: string, attempt = 0): Promise<{ mime: string; data: Uint8Array }> {
        const response = await fetch(url, {
            headers: { 'user-agent': UA, referer: `${MIRROR}/`, accept: 'image/*,*/*' },
            signal: AbortSignal.timeout(60000)
        });
        if (!response.ok) {
            if (attempt < 2 && (response.status === 429 || response.status === 403 || response.status >= 500)) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
                return this.fetchPageImage(url, attempt + 1);
            }
            throw new SourceError(`HTTP ${response.status} fetching page image on ${this.label}`, this.id);
        }
        return {
            mime: response.headers.get('content-type')?.split(';')[0] || 'image/webp',
            data: new Uint8Array(await response.arrayBuffer())
        };
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const url = new URL('/v1.0/search', API);
            url.searchParams.set('q', 'a');
            url.searchParams.set('limit', '1');
            const items = await this._fetchJson<DevSearchItem[]>(url);
            if ((items || []).length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Réponse vide (API modifiée ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }

    /** Resolve the diverging art catalog entry (slug/hid differ from dev). */
    private async _findArtComic(manga: MangaInfo): Promise<ArtComic | undefined> {
        const cached = this.artComicCache.get(manga.id);
        if (cached) {
            return cached;
        }
        const url = new URL('/api/search', MIRROR);
        url.searchParams.set('q', manga.title);
        const response = await this._fetchJson<ArtSearchResponse>(url);
        const candidates = (response.data || []).filter(item => item.slug && item.title);
        const devSlug = manga.url
            ?.match(/\/comic\/([^/]+)/)?.[1]
            ?.toLowerCase()
            .replace(/^\d+-/, '');
        const match =
            candidates.find(item => item.hid === manga.id) ||
            (devSlug ? candidates.find(item => item.slug?.toLowerCase() === devSlug) : undefined) ||
            candidates.find(item => item.title?.toLowerCase() === manga.title.toLowerCase());
        if (match) {
            this.artComicCache.set(manga.id, match);
        }
        return match;
    }

    /** art chapter-list: all languages mixed -> filter, paginate to last_page. */
    private async _artChapters(art: ArtComic): Promise<ChapterInfo[]> {
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        for (let page = 1; ; page++) {
            const url = new URL(`/api/comics/${art.slug}/chapter-list`, MIRROR);
            url.searchParams.set('page', String(page));
            const response = await this._fetchJson<ArtChapterListResponse>(url);
            for (const chapter of response.data || []) {
                if (chapter.lang !== CHAPTER_LANG || !chapter.hid || !chapter.chap) {
                    continue;
                }
                this._addChapter(chapters, seen, chapter, `${MIRROR}/comic/${art.slug}/${chapter.hid}-chapter-${chapter.chap}-${chapter.lang}`);
            }
            const totalPages = response.pagination?.last_page || 1;
            if (page >= totalPages) {
                break;
            }
        }
        return chapters;
    }

    /** dev fallback: hids may not exist on art (catalog divergence). */
    private async _devChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const slug = manga.url?.match(/\/comic\/([^/]+)/)?.[1];
        const base = slug ? `${MIRROR}/comic/${slug}` : `${MIRROR}/comic/x`;
        const chapters: ChapterInfo[] = [];
        const seen = new Set<string>();
        // hard page cap (madara-style) + stall detection: a server that keeps
        // returning the same full page must not turn this into an endless loop
        const MAX_PAGES = 50; // 50 x 50 = hard cap of 2500 chapters
        let addedPreviousPage = -1;
        for (let page = 1; page <= MAX_PAGES; page++) {
            const url = new URL(`/comic/${manga.id}/chapters`, API);
            url.searchParams.set('page', String(page));
            url.searchParams.set('limit', '50');
            url.searchParams.set('lang', CHAPTER_LANG);
            const response = await this._fetchJson<DevChaptersResponse>(url);
            const items = response.chapters || [];
            for (const chapter of items) {
                if (!chapter.hid || !chapter.chap) {
                    continue;
                }
                this._addChapter(chapters, seen, chapter, `${base}/${chapter.hid}-chapter-${chapter.chap}-${chapter.lang || CHAPTER_LANG}`);
            }
            if (items.length < (response.limit || 50) || chapters.length === addedPreviousPage) {
                break;
            }
            addedPreviousPage = chapters.length;
        }
        return chapters;
    }

    /** The APIs list one row per scanlation group: keep a single row per
     *  language+chapter number (first release wins, like the MangaDex connector). */
    private _addChapter(chapters: ChapterInfo[], seen: Set<string>, chapter: DevChapter, url: string): void {
        const number = Number(chapter.chap) || chapter.chap;
        const key = `${chapter.lang || CHAPTER_LANG}:c${number}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        chapters.push(this._chapterInfo(chapter, url));
    }

    private _chapterInfo(chapter: DevChapter, url: string): ChapterInfo {
        return {
            id: chapter.hid as string,
            title: this._chapterTitle(chapter),
            url,
            language: chapter.lang
        };
    }

    /** "Vol. X Ch. Y - Title" + scanlation group like the legacy connector. */
    private _chapterTitle(chapter: DevChapter): string {
        let title = '';
        if (chapter.vol) {
            title += `Vol.${chapter.vol}`;
        }
        if (chapter.chap) {
            title += `${title ? ' ' : ''}Ch.${chapter.chap}`;
        }
        if (chapter.title) {
            title += `${title ? ' - ' : ''}${chapter.title}`;
        }
        const group = chapter.group_name?.filter(Boolean).join(', ');
        if (group) {
            title += ` [${group}]`;
        }
        return title || `Chapter ${chapter.hid}`;
    }

    /** Reader HTML; retry transient Cloudflare shells, then browser fallback. */
    private async _getReaderHtml(rawUrl: string): Promise<string> {
        // chapter urls may come back from API requests: pin to the reader host
        const url = pinToOrigin(rawUrl, MIRROR, { id: this.id });
        for (let attempt = 0; attempt < 3; attempt++) {
            let response: Response | undefined;
            try {
                response = await fetch(url, {
                    headers: { 'user-agent': randomUserAgent(), accept: 'text/html,application/xhtml+xml', 'accept-language': 'en,*;q=0.5' },
                    redirect: 'follow',
                    signal: AbortSignal.timeout(30000)
                });
            } catch {
                response = undefined;
            }
            const body = response ? await response.text().catch(() => '') : '';
            if (response?.ok && !isAntiBotShell(body, response.status)) {
                return body;
            }
            if (response && response.status === 404) {
                throw new SourceError(`Chapitre absent du miroir ${MIRROR} (catalogues dev/art divergents)`, this.id);
            }
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
        if (browserEnabled()) {
            const rendered = await getPageHTML(url, { timeoutMs: 30_000 }).catch(() => undefined);
            if (rendered?.html && !isAntiBotShell(rendered.html)) {
                return rendered.html;
            }
        }
        throw new SourceError(`Page lecteur inaccessible sur ${new URL(url).hostname}`, this.id);
    }

    /** ~3 req/s to stay under the dev API rate limit (200/min). */
    private async _throttle(): Promise<void> {
        const wait = this.lastRequestAt + 350 - Date.now();
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait));
        }
        this.lastRequestAt = Date.now();
    }

    /** JSON GET with retries: api.comick.dev intermittently answers a 403
     *  Cloudflare shell which clears by itself after a short backoff. */
    private async _fetchJson<T>(url: URL, attempt = 0): Promise<T> {
        await this._throttle();
        let response: Response | undefined;
        try {
            response = await fetch(url, {
                headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en,*;q=0.5' },
                signal: AbortSignal.timeout(30000)
            });
        } catch (error) {
            if (attempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
                return this._fetchJson<T>(url, attempt + 1);
            }
            throw error instanceof SourceError ? error : new SourceError(`GET ${url.pathname} failed`, this.id, error);
        }
        const body = await response.text().catch(() => '');
        const shell = body.startsWith('<!DOCTYPE') || body.startsWith('<html');
        if (response.ok && !shell) {
            try {
                return JSON.parse(body) as T;
            } catch (error) {
                throw new SourceError(`JSON invalide sur ${url.hostname}${url.pathname}`, this.id, error);
            }
        }
        if (attempt < 3 && (shell || response.status === 403 || response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
            return this._fetchJson<T>(url, attempt + 1);
        }
        throw new SourceError(`HTTP ${response.status} on ${url.hostname}${url.pathname}`, this.id);
    }
}

export const comick = new ComickConnector();
