/**
 * Normalized source adapter interface. Both the legacy Hakuneko connectors
 * (wrapped) and the rewritten native connectors implement this, so the rest
 * of the service (library, downloader, scheduler, API) is source-agnostic.
 */

export interface MangaInfo {
    /** Source-scoped identifier (legacy: connector manga id, native: url or slug). */
    id: string;
    title: string;
    /** Absolute resource URL when known. */
    url?: string;
    thumbnail?: string;
    /** Languages the manga is available in on this source, when the source
     *  knows it up-front (native MangaDex search). Lets callers drop titles
     *  with no chapter in the preferred languages before they look broken. */
    languages?: string[];
}

export interface ChapterInfo {
    /** Source-scoped identifier. */
    id: string;
    title: string;
    url?: string;
    language?: string;
}

/** Page list = image URLs (or connector:// URIs for legacy protected media). */
export type PageList = string[];

/** Result of a lightweight reachability probe. */
export interface HealthResult {
    ok: boolean;
    latencyMs: number;
    error?: string;
    /** How the probe (or the source's transport) reached the site: plain HTTP
     *  or through the solved anti-bot browser session. */
    via?: 'http' | 'browser';
}

export interface SourceAdapter {
    readonly id: string;
    readonly label: string;
    readonly tags: string[];
    readonly kind: 'legacy' | 'native';
    readonly url?: string;

    /** Warm up the source (session/cookies). Must be idempotent. */
    initialize(): Promise<void>;

    /** Search mangas by free-text query. */
    searchMangas(query: string): Promise<MangaInfo[]>;

    /** List chapters for a manga. */
    getChapters(manga: MangaInfo): Promise<ChapterInfo[]>;

    /** List page image URLs for a chapter. */
    getPages(manga: MangaInfo, chapter: ChapterInfo): Promise<PageList>;

    /** Lightweight reachability probe (used by the health-check system). */
    checkHealth(): Promise<HealthResult>;
    /** Optional: fetch a page image through the source's own transport.
     *  Present on connectors that may run inside a solved browser session
     *  (their image hosts can block plain HTTP too). */
    fetchPageImage?(url: string): Promise<{ mime: string; data: Uint8Array }>;
}

export class SourceError extends Error {
    constructor(
        message: string,
        readonly sourceId?: string,
        readonly cause?: unknown
    ) {
        super(message);
        this.name = 'SourceError';
    }
}
/** Human-readable message for an unknown thrown value (fetch failures, etc.). */
export function errorMessage(error: unknown): string {
    return String((error as { message?: unknown })?.message || error);
}
