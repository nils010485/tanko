/**
 * Wraps a legacy Hakuneko connector behind the normalized SourceAdapter
 * interface. The legacy API is callback based and coupled to the global
 * `Engine`; this adapter only reads from it (manga/chapter/page lists).
 */
import { SourceError, errorMessage, type ChapterInfo, type HealthResult, type MangaInfo, type PageList, type SourceAdapter } from './types.js';
import { isAntiBotShell } from '../shims/browser.js';

export class LegacySourceAdapter implements SourceAdapter {

    readonly kind = 'legacy' as const;

    constructor(readonly connector: any) {}

    get id(): string {
        return String(this.connector.id);
    }

    get label(): string {
        return this.connector.label;
    }

    get tags(): string[] {
        return this.connector.tags || [];
    }

    get url(): string | undefined {
        return this.connector.url;
    }

    async initialize(): Promise<void> {
        if (!this.connector.initialized) {
            await this.connector.initialize();
        }
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        return this._guard(async () => {
            await this.initialize();
            const needle = query.trim().toLowerCase();
            const mangas = await this._promisify<any[]>(callback => this.connector._getMangaList(callback));
            return (mangas || [])
                .filter(manga => manga.title && manga.title.toLowerCase().includes(needle))
                .map(manga => this._toMangaInfo(manga));
        }, 'search');
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        return this._guard(async () => {
            await this.initialize();
            const legacyManga = { connector: this.connector, id: manga.id, title: manga.title };
            const chapters = await this._promisify<any[]>(callback => this.connector._getChapterList(legacyManga, callback));
            return (chapters || []).map(chapter => ({
                id: chapter.id,
                title: chapter.title,
                language: chapter.language
            }));
        }, 'chapter list');
    }

    async getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        return this._guard(async () => {
            await this.initialize();
            const legacyManga = { connector: this.connector, id: manga.id, title: manga.title };
            const legacyChapter = { manga: legacyManga, id: chapter.id, title: chapter.title };
            const pages: any = await this._promisify<any>(callback => this.connector._getPageList(legacyManga, legacyChapter, callback));
            // Anime chapters return { mirrors | video } objects — only image lists are supported.
            if (!Array.isArray(pages)) {
                throw new SourceError(`Chapter "${chapter.title}" is not an image chapter (anime/media not supported)`, this.id);
            }
            return pages;
        }, 'page list');
    }

    /**
     * Honest health probe, in two steps:
     *  1. root page must be reachable AND carry real content (anti-bot shells
     *     like "Loading..." are detected and reported as errors);
     *  2. the connector's REAL list operation is attempted (bounded to 12s):
     *     a 404/empty list means the source is broken even when the root page
     *     looks fine (site moved its catalog). Sources that are merely too slow
     *     to verify (full-catalog scanners) fall back to the root check result.
     */
    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        if (!this.connector.url) {
            return { ok: false, latencyMs: 0, error: 'No base URL' };
        }

        try {
            const request = new Request(this.connector.url, this.connector.requestOptions);
            const response: Response = await Promise.race([
                (globalThis as any).Engine.Request.fetch(request, 20000),
                new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
            ]);
            if (response.status >= 500) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const body = await response.text();
            if (isAntiBotShell(body)) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Page protégée par anti-bot (JavaScript requis)' };
            }
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }

        try {
            const listPromise = this._promisify<any[]>(callback => this.connector._getMangaList(callback));
            const SLOW = Symbol('slow');
            const mangas = await Promise.race([
                listPromise,
                new Promise<any>(resolve => setTimeout(() => resolve(SLOW), 12000))
            ]);
            if (mangas === SLOW) {
                // too slow to verify (catalog scanner) but root has real content
                return { ok: true, latencyMs: Date.now() - startedAt };
            }
            if (!Array.isArray(mangas) || mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de mangas vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: this._describeError(error) };
        }
    }

    /** Wrap a legacy callback-style connector call into a Promise. */
    private _promisify<T>(invoke: (callback: (error: any, result: T) => void) => void): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('legacy connector timed out')), 90_000);
            timer.unref?.();
            invoke((error, result) => {
                clearTimeout(timer);
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });
    }

    private _toMangaInfo(manga: any): MangaInfo {
        const info: MangaInfo = { id: manga.id, title: manga.title };
        if (typeof manga.id !== 'string') {
            return info;
        }
        try {
            if (manga.id.startsWith('/')) {
                info.url = new URL(manga.id, this.connector.url).href;
            } else if (manga.id.startsWith('http')) {
                info.url = manga.id;
            }
        } catch { /* keep id only */ }
        return info;
    }

    /** Convert any low-level failure (network, SSL, DNS, connector bug) into a SourceError. */
    private async _guard<T>(operation: () => Promise<T>, action: string): Promise<T> {
        try {
            return await operation();
        } catch (error: any) {
            if (error instanceof SourceError) {
                throw error;
            }
            const reason = this._describeError(error);
            throw new SourceError(`${this.label}: ${action} failed (${reason})`, this.id, error);
        }
    }

    private _describeError(error: any): string {
        const causeMessage = String(error?.cause?.message || error?.cause?.code || '');
        if (/ENOTFOUND|EAI_AGAIN/i.test(causeMessage)) {
            return 'domaine introuvable';
        }
        if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(causeMessage)) {
            return 'connexion impossible';
        }
        if (/SSL|TLS|certificate/i.test(causeMessage)) {
            return 'erreur SSL/TLS';
        }
        if (error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message || ''))) {
            return 'timeout';
        }
        return String(error?.message || error || 'erreur inconnue');
    }
}
