/**
 * Structural types for the untyped legacy HakuNeko objects (vendored .mjs
 * connectors, manga/chapter records) flowing through the engine, the shims
 * and the legacy adapter. Only the surface Tanko actually touches is
 * described — everything else stays invisible to the type system.
 */

/** A manga record as passed around by legacy connectors. */
export interface LegacyManga {
    id: string;
    title: string;
    connector: LegacyConnector;
    language?: string;
}

/** A chapter record as passed around by legacy connectors. */
export interface LegacyChapter {
    id: string;
    title: string;
    manga: LegacyManga;
    language?: string;
}

/** A vendored HakuNeko connector instance (untyped .mjs class). */
export interface LegacyConnector {
    id: string;
    label: string;
    tags?: string[];
    url?: string;
    initialized: boolean;
    requestOptions?: RequestInit;
    config?: { path?: { value: string } };
    initialize(): Promise<void>;
    handleConnectorURI(uri: URL): Promise<{ data: BlobPart; mimeType: string }>;
    /** Optional fast path: single-request site search (falls back to the full catalog scan). */
    _searchMangas?(query: string): Promise<LegacyManga[]>;
    _getMangaList(callback: (error: unknown, mangas?: LegacyManga[]) => void): void;
    _getChapterList(manga: LegacyManga, callback: (error: unknown, chapters?: LegacyChapter[]) => void): void;
    _getPageList(manga: LegacyManga, chapter: LegacyChapter, callback: (error: unknown, pages?: unknown) => void): void;
}
