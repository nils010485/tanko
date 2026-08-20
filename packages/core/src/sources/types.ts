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
