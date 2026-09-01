/**
 * Wraps a legacy Hakuneko connector behind the normalized SourceAdapter
 * interface. The legacy API is callback based and coupled to the global
 * `Engine`; this adapter only reads from it (manga/chapter/page lists).
 */

import type { LegacyChapter, LegacyConnector, LegacyManga } from '../legacy-types.js';
import { withAbortScope } from '../shims/abort-scope.js';
import { browserEnabled, getPageHTML, isAntiBotShell } from '../shims/browser.js';
import { type ChapterInfo, errorMessage, type HealthResult, type MangaInfo, type PageList, type SourceAdapter, SourceError } from './types.js';

export class LegacySourceAdapter implements SourceAdapter {
    readonly kind = 'legacy' as const;

    constructor(readonly connector: LegacyConnector) {}

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
            // connectors with a site search endpoint answer in one request;
            // the default flow crawls the whole catalog (minutes on some)
            if (typeof this.connector._searchMangas === 'function') {
                const mangas = await this.connector._searchMangas(query);
                return (mangas || []).map(manga => this._toMangaInfo(manga));
            }
            const needle = query.trim().toLowerCase();
            const mangas = await this._promisify<LegacyManga[] | undefined>(callback => this.connector._getMangaList(callback));
            return (mangas || []).filter(manga => manga.title?.toLowerCase().includes(needle)).map(manga => this._toMangaInfo(manga));
        }, 'search');
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        return this._guard(async () => {
            await this.initialize();
            const legacyManga = { connector: this.connector, id: manga.id, title: manga.title };
            const chapters = await this._promisify<LegacyChapter[] | undefined>(callback => this.connector._getChapterList(legacyManga, callback));
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
            const pages: unknown = await this._promisify<unknown>(callback => this.connector._getPageList(legacyManga, legacyChapter, callback));
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
        let renderedViaBrowser = false;
        if (!this.connector.url) {
            return { ok: false, latencyMs: 0, error: 'No base URL' };
        }

        try {
            const request = new Request(this.connector.url, this.connector.requestOptions);
            const response: Response = await Promise.race([
                globalThis.Engine.Request.fetch(request, 20000),
                new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('timeout 20s')), 20000))
            ]);
            if (response.status >= 500) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
            }
            const body = await response.text();
            if (isAntiBotShell(body)) {
                // the catalog operations (fetchUI) retry anti-bot shells in a
                // real browser — the health check must agree or protected
                // sources look dead while they actually work
                if (browserEnabled()) {
                    const rendered = await getPageHTML(this.connector.url, { timeoutMs: 30_000 }).catch(() => undefined);
                    if (rendered && !isAntiBotShell(rendered.html)) {
                        renderedViaBrowser = true;
                    } else {
                        return { ok: false, latencyMs: Date.now() - startedAt, error: 'Page protégée par anti-bot (JavaScript requis)' };
                    }
                } else {
                    return { ok: false, latencyMs: Date.now() - startedAt, error: 'Page protégée par anti-bot (JavaScript requis)' };
                }
            }
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }

        try {
            // when the catalog scan loses the 12s race, abort the whole
            // crawl instead of letting it run as a zombie
            const SLOW = Symbol('slow');
            let crawlScope: AbortController | undefined;
            const listPromise = withAbortScope(scope => {
                crawlScope = scope;
                return this._promisify<LegacyManga[] | undefined>(callback => this.connector._getMangaList(callback));
            });
            let slowTimer: ReturnType<typeof setTimeout> | undefined;
            const mangas = await Promise.race([
                listPromise,
                new Promise<typeof SLOW>(resolve => {
                    slowTimer = setTimeout(() => {
                        crawlScope?.abort(new Error('health check deadline exceeded'));
                        resolve(SLOW);
                    }, 12000);
                    slowTimer.unref?.();
                })
            ]).finally(() => clearTimeout(slowTimer));
            if (mangas === SLOW) {
                // too slow to verify (catalog scanner) but root has real content
                return { ok: true, latencyMs: Date.now() - startedAt, via: renderedViaBrowser ? 'browser' : undefined };
            }
            if (!Array.isArray(mangas) || mangas.length === 0) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de mangas vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt, via: renderedViaBrowser ? 'browser' : undefined };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: this._describeError(error) };
        }
    }

    private _promisify<T>(invoke: (callback: (error: unknown, result: T) => void) => void): Promise<T> {
        // abort scope: on timeout every in-flight fetch dies so the catalog
        // becomes collectible instead of piling up (see shims/abort-scope.ts)
        return withAbortScope(
            scope =>
                new Promise<T>((resolve, reject) => {
                    const timer = setTimeout(() => {
                        const reason = new Error('legacy connector timed out');
                        scope.abort(reason);
                        reject(reason);
                    }, 90_000);
                    timer.unref?.();
                    invoke((error, result) => {
                        clearTimeout(timer);
                        if (error) {
                            reject(error);
                        } else {
                            resolve(result);
                        }
                    });
                })
        );
    }

    private _toMangaInfo(manga: LegacyManga): MangaInfo {
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
        } catch {
            /* keep id only */
        }
        return info;
    }

    /** Convert any low-level failure (network, SSL, DNS, connector bug) into a SourceError. */
    private async _guard<T>(operation: () => Promise<T>, action: string): Promise<T> {
        try {
            return await operation();
        } catch (error: unknown) {
            if (error instanceof SourceError) {
                throw error;
            }
            const reason = this._describeError(error);
            throw new SourceError(`${this.label}: ${action} failed (${reason})`, this.id, error);
        }
    }

    private _describeError(error: unknown): string {
        const detail = error as { message?: unknown; name?: unknown; cause?: { message?: unknown; code?: unknown } } | undefined;
        const causeMessage = String(detail?.cause?.message || detail?.cause?.code || '');
        if (/ENOTFOUND|EAI_AGAIN/i.test(causeMessage)) {
            return 'domaine introuvable';
        }
        if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(causeMessage)) {
            return 'connexion impossible';
        }
        if (/SSL|TLS|certificate/i.test(causeMessage)) {
            return 'erreur SSL/TLS';
        }
        if (detail?.name === 'TimeoutError' || /timeout/i.test(String(detail?.message || ''))) {
            return 'timeout';
        }
        return String(detail?.message || error || 'erreur inconnue');
    }
}
