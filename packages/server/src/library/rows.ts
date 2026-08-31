/**
 * Row shapes, DTO helpers and SQL fragments shared by the library modules.
 * The store (store.ts) and its extracted modules (outages, chapters,
 * migration) all speak in these terms.
 */

/** Shared INSERT statements for chapter rows (6-column snapshot, 6-column forced 'new', full 8-column). */
export const SQL_INSERT_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, ?, ?)`;
export const SQL_INSERT_NEW_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, 'new', ?)`;
export const SQL_INSERT_CHAPTER_FULL = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, path, discovered_at, downloaded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

export interface EntryRow {
    id: number;
    source_id: string;
    source_label: string;
    manga_id: string;
    title: string;
    url: string | null;
    thumbnail: string | null;
    auto_download: number;
    check_failures: number;
    migration_suggestion: string | null;
    migration_dismissed: string | null;
    hidden: number;
    /** Paused (follow off): the entry stays visible but the scheduler ignores it. */
    paused: number;
    last_checked_at: string | null;
    /** Date the last new chapter was discovered (drives the stale-series auto-pause). */
    last_chapter_at: string | null;
    added_at: string;
    /** Stalled-probe back-off: consecutive probes without a richer source
     *  found, and the earliest date the next probe may run (null = any time). */
    staleness_misses: number;
    staleness_next_probe_at: string | null;
    /** Alternative titles (JSON array) searched by the failover. */
    aliases: string | null;
}

/** A source-wide download outage (≥ SOURCE_OUTAGE_ENTRIES distinct entries
 *  failing inside the window). escalatedAt non-null = the suspension of
 *  migration is lifted: the outage is old enough to look permanent. */
export interface SourceOutage {
    sourceId: string;
    startedAt: string;
    lastSeenAt: string;
    failures: number;
    escalatedAt: string | null;
}

/** Raw row of the source_outages table. */
export interface OutageRow {
    source_id: string;
    started_at: string;
    last_seen_at: string;
    failures: number;
    escalated_at: string | null;
    closed_at: string | null;
}

export function toOutage(row: OutageRow): SourceOutage {
    return {
        sourceId: row.source_id,
        startedAt: row.started_at,
        lastSeenAt: row.last_seen_at,
        failures: row.failures,
        escalatedAt: row.escalated_at
    };
}

export interface ChapterRow {
    id: number;
    entry_id: number;
    chapter_id: string;
    title: string;
    language: string | null;
    status: 'new' | 'missing' | 'queued' | 'downloading' | 'downloaded' | 'failed';
    path: string | null;
    discovered_at: string;
    downloaded_at: string | null;
}

export interface MigrationTarget {
    sourceId: string;
    sourceLabel: string;
    mangaId: string;
    mangaTitle: string;
    url?: string;
    score?: number;
    /** Chapters in the preferred languages, set once the candidate's chapter
     *  list has actually been fetched (picker, detection and outage flows). */
    chapterCount?: number;
}

/** Probe candidate of the stalled-source failover regime. */
export interface StalledCandidate {
    id: number;
    sourceId: string;
    title: string;
    chapterCount: number;
}

/** Case/punctuation-insensitive title key for cross-source duplicate
 *  detection (keeps letters of any script and digits, drops the rest). */
export function normalizeTitle(title: string): string {
    return title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks — "Café" == "Cafe" (mirrors similarity.ts)
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** Aliases are stored as a JSON array; normalization mirrors titleSimilarity's
 *  expectations: trimmed, 3–200 chars, deduplicated case-insensitively, never
 *  equal to the entry's own title, capped so a fat-fingered paste cannot
 *  multiply the failover's search queries. */
export function normalizeAliases(title: string, aliases: ReadonlyArray<string>): string[] {
    const seen = new Set([normalizeTitle(title)]);
    const kept: string[] = [];
    for (const alias of aliases) {
        const trimmed = alias.trim();
        const key = normalizeTitle(trimmed);
        if (trimmed.length < 3 || trimmed.length > 200 || seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(trimmed);
        if (kept.length >= 10) {
            break;
        }
    }
    return kept;
}
