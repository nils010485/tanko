/**
 * Shared DTO types between the server (REST/WS) and the dashboard.
 */

// ---------------------------------------------------------------------------
// Sources & discovery
// ---------------------------------------------------------------------------

export interface SourceDto {
    id: string;
    label: string;
    tags: string[];
    /** 'legacy' = adapted Hakuneko connector, 'native' = rewritten connector */
    kind: 'legacy' | 'native';
    url?: string;
    health?: 'ok' | 'error' | 'checking' | 'untested';
    healthLatencyMs?: number;
    healthCheckedAt?: string;
    /** Manually hidden (broken) until the next full health re-check. */
    hidden?: boolean;
}
export interface SourceHealthDto {
    sourceId: string;
    status: 'ok' | 'error' | 'checking' | 'untested';
    latencyMs?: number;
    error?: string;
    checkedAt?: string;
}

/** Last completed connectors sync from upstream Hakuneko. */
export interface ConnectorsUpdateInfo {
    date: string;
    commit: string;
    previousCount: number;
    connectorCount: number;
}

/** Updater state for the dashboard (GET /api/sources/update). */
export interface ConnectorsUpdateStatus {
    running: boolean;
    last: ConnectorsUpdateInfo | null;
    activeCount: number;
}

export interface MangaDto {
    sourceId: string;
    id: string;
    title: string;
    url?: string;
    thumbnail?: string;
}
export interface ChapterDto {
    sourceId: string;
    mangaId: string;
    id: string;
    title: string;
    language?: string;
}

// ---------------------------------------------------------------------------
// Global search (Discover)
// ---------------------------------------------------------------------------

/** One source's outcome in a global (all-sources) search. */
export interface GlobalSearchSourceResultDto {
    sourceId: string;
    sourceLabel: string;
    kind: 'legacy' | 'native';
    status: 'ok' | 'error' | 'timeout' | 'skipped';
    tookMs?: number;
    error?: string;
    /** True when the source declares languages and none is preferred: results
     *  are shown de-emphasized instead of hidden (the title may still be wanted). */
    outOfLanguages?: boolean;
    mangas: MangaDto[];
}

/** Polling snapshot of a running or finished global search. */
export interface GlobalSearchStatusDto {
    jobId: number;
    query: string;
    total: number;
    completed: number;
    done: boolean;
    results: GlobalSearchSourceResultDto[];
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** Suggested source migration (awaiting user confirmation). */
export interface MigrationSuggestion {
    sourceId: string;
    sourceLabel: string;
    mangaId: string;
    mangaTitle: string;
    score: number;
    /** Chapters offered by the suggested source (set by the picker/detection). */
    chapterCount?: number;
}

/** Same series on another source, as shown by the manual source picker. */
export interface SourceAlternativeDto {
    sourceId: string;
    sourceLabel: string;
    mangaId: string;
    mangaTitle: string;
    url?: string;
    /** Title similarity, 0..1. */
    score?: number;
    /** Chapters offered by this source in the preferred languages. */
    chapterCount: number;
}

/** Response of GET /api/library/:id/alternatives (manual source picker). */
export interface SourceAlternativesResponseDto {
    current: { sourceId: string; sourceLabel: string; chapterCount: number };
    alternatives: SourceAlternativeDto[];
    /** Names the search was retried under after an automatic AniList lookup
     *  (set only when the first crawl found nothing and new names were merged). */
    autoAliases?: string[];
}

export interface LibraryEntryDto {
    id: number;
    sourceId: string;
    sourceLabel: string;
    mangaId: string;
    title: string;
    thumbnail?: string;
    /** Cached first-chapter WebP cover (set when the cover cache is enabled). */
    coverUrl?: string;
    autoDownload: boolean;
    chapterCount: number;
    downloadedCount: number;
    newCount: number;
    /** Chapters currently in 'failed' state (drives the download-new disabled rule). */
    failedCount?: number;
    lastCheckedAt?: string;
    /** Date the last new chapter was discovered (drives the stale-series auto-pause). */
    lastChapterAt?: string;
    addedAt: string;
    /** Consecutive failed checks against the current source. */
    checkFailures?: number;
    /** Suggested source migration (awaiting user confirmation). */
    migrationSuggestion?: MigrationSuggestion;
    /** Migration target the user explicitly dismissed (detection must not re-suggest it). */
    dismissedMigration?: MigrationSuggestion;
    /** A migration snapshot exists -> the last source change can be undone. */
    canRollbackMigration?: boolean;
    /** Hidden entries stay out of the default library list and the scheduler. */
    hidden?: boolean;
    /** Paused entries stay visible but are not monitored (auto or manual pause). */
    paused?: boolean;
    /** Alternative titles (manual or AniList) searched by the failover when
     *  the current source goes bad — manhwas are often listed under another name. */
    aliases?: string[];
}

/** Actions accepted by POST /api/library/bulk (library selection mode). */
export type LibraryBulkAction = 'pause' | 'resume' | 'hide' | 'unhide' | 'check' | 'downloadNew' | 'rematch' | 'delete';
/** Recap returned by POST /api/library/bulk. */
export interface LibraryBulkSummary {
    processed: number;
    failed: number;
    newChapters: number;
    queued: number;
    deleted: number;
    /** Rematch skipped on purpose (downloads still running for the entry). */
    skipped: number;
}

export interface LibraryChapterDto {
    id: number;
    entryId: number;
    chapterId: string;
    title: string;
    language?: string;
    status: 'new' | 'missing' | 'queued' | 'downloading' | 'downloaded' | 'failed' | 'lost';
    path?: string;
    /** Local-only chapter: a file on disk with no source counterpart (ghost row). */
    localOnly?: boolean;
    downloadedAt?: string;
    /** Number of history entries (path/status changes) for this chapter. */
    historyCount?: number;
    /** The matching download job exhausted its fast retry ladder: automatic
     *  retries continue on the slow revalidation tier (at most one per week). */
    retryExhausted?: boolean;
}

export interface DeadSeriesDto {
    id: number;
    title: string;
    /** Last known series folder on disk (null when it cannot be determined). */
    directory: string | null;
}

export type DownloadStatus = 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';

export interface DownloadJobDto {
    id: number;
    entryId: number | null;
    sourceId: string;
    mangaId: string;
    chapterId: string;
    mangaTitle: string;
    chapterTitle: string;
    status: DownloadStatus;
    progress: number;
    pagesTotal: number;
    pagesDone: number;
    error?: string;
    path?: string;
    /** Auto-retries consumed so far (>= AUTO_RETRY_MAX = slow revalidation tier). */
    autoRetries?: number;
    /** True when this exhausted job sits in the slow revalidation tier (an
     *  entry-linked, non-lost chapter of a visible, unpaused entry). */
    revalidating?: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface DownloadsPageDto {
    jobs: DownloadJobDto[];
    /** Total jobs matching the current filters (across all pages). */
    total: number;
    /** Job count per status, ignoring filters. */
    counts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface ScheduleSettingsDto {
    enabled: boolean;
    cron: string;
    autoDownload: boolean;
    /** Hide series with no new chapter for over 120 days. */
    autoUnfollow: boolean;
    notifications: NotificationSettingsDto;
}

export interface ScheduleStatusDto {
    enabled: boolean;
    cron: string;
    nextRunAt?: string;
    lastRunAt?: string;
    lastRunResult?: string;
    seriesChecked: number;
    newChaptersFound: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Queue settings actually served by GET /api/settings (queue.getSettings()). */
export interface QueueSettingsDto {
    /** Base directory for downloads. */
    dataDirectory: string;
    /** 'source' = <base>/<Source>/<Série>/ (Hakuneko), 'series' = <base>/<Série>/. */
    directoryLayout: 'source' | 'series';
    /** 'img' = folder of images, 'cbz' = comic archive. */
    chapterFormat: 'img' | 'cbz';
    /** Max number of distinct sources downloading at the same time. */
    parallelSources: number;
    /** Max number of chapters downloaded in parallel per source. */
    concurrencyPerSource: number;
    /** Minimum delay (ms) between two requests to the same domain. */
    throttleMs: number;
    /** Days to keep finished jobs (completed/failed/cancelled); 0 keeps them forever. */
    historyRetentionDays: number;
}

/** Response of GET /api/settings (diskUsedBytes is absent on PATCH). */
export interface AppSettingsResponseDto {
    queue: QueueSettingsDto;
    preferredLanguages: string[];
    /** Dashboard interface language; English until the user picks otherwise. */
    uiLanguage: 'en' | 'fr';
    /** Use the first downloaded chapter page as the library cover (WebP cache in SQLite). */
    useFirstChapterCovers: boolean;
    /** Opt-in: starved sources (very few chapters) get searched on other
     *  sources after a check; a migration suggestion is stored when one of
     *  them offers far more chapters. */
    incompleteSourceDetection: boolean;
    /** Opt-in: stalled series (no new chapter for abnormally long given
     *  their own rhythm) get searched on other sources; a migration
     *  suggestion is stored when one of them carries more chapters. */
    stalledSourceDetection: boolean;
    diskUsedBytes: number;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Event families shown as icons/filter chips in the Activity tab. */
export type LogCategory = 'check' | 'source' | 'failover' | 'scan' | 'system';

/** Structured extras carried by `log` events and persisted activity rows.
 *  `code` + `params` let the dashboard translate the message (the raw
 *  `message` stays as fallback); the entity refs make the line clickable. */
export interface LogEventMeta {
    category?: LogCategory;
    code?: string;
    params?: Record<string, string | number>;
    entryId?: number;
    sourceId?: string;
}

/** One Activity tab entry (GET /api/activity, live WS `log` events). */
export interface ActivityLogDto extends LogEventMeta {
    id: number;
    level: LogLevel;
    message: string;
    at: string;
}

/** Long-running background job (bulk tools) — GET /api/activity/jobs. */
export interface JobStatusDto {
    id: number;
    /** i18n code prefix of the tool, e.g. 'scan.betterSources'. */
    kind: string;
    label: string;
    running: boolean;
    done: number;
    total: number;
    /** Migrations/suggestions found, depending on the tool. */
    hits: number;
    startedAt: string;
    finishedAt?: string;
    cancelled?: boolean;
}

/** System pulse — GET /api/activity/stats. */
export interface ActivityStatsDto {
    /** Visible library entries. */
    series: number;
    /** New chapters discovered by checks over the last 7 days (activity log). */
    newChapters7d: number;
    /** Visible entries whose source keeps failing checks. */
    activeFailures: number;
    /** Healthy vs known sources (health probes). */
    sourcesHealthy: number;
    sourcesTotal: number;
    /** error-level log rows newer than `?since=` — unread-errors badge. */
    errorsSince?: number;
}

/** Per-event webhook opt-in. Absent fields fall back to the defaults
 *  (only new chapters notify — the historical behavior). */
export interface NotificationEventToggles {
    newChapters: boolean;
    outages: boolean;
    migrations: boolean;
    scans: boolean;
}

export interface NotificationSettingsDto {
    enabled: boolean;
    webhookUrl: string;
    events?: Partial<NotificationEventToggles>;
}

/** Queue counters (GET /api/downloads/status, pause/resume responses, WS pushes). */
export interface QueueStatusDto {
    paused: boolean;
    /** Jobs currently downloading (workers running). */
    active: number;
    /** Jobs waiting in the queue. */
    queued: number;
}

// ---------------------------------------------------------------------------
// Import (existing Hakuneko library migration)
// ---------------------------------------------------------------------------

/** Phases of the persistent import pipeline (scan → match → confirm → sync). */
export type ImportJobPhase = 'scanning' | 'matching' | 'ready' | 'syncing' | 'done' | 'error';

/** Match confirmation policy: 'auto' = high-confidence only, 'all' = also
 *  review tier, 'none' = wait for the user. */
export type AutoConfirmMode = 'auto' | 'all' | 'none';

/** Match tier assigned by the similarity scorer. */
export type MatchConfidence = 'auto' | 'review' | 'none';

/** Options of a POST /api/import/start job. */
export interface ImportOptionsDto {
    /** 'auto': confirm high-confidence matches only; 'all': also review-tier; 'none': wait for the user. */
    autoConfirm?: AutoConfirmMode;
    /** auto-download future new chapters on imported entries (default false). */
    autoDownload?: boolean;
    /** parallel search workers (default: server-side MATCH_CONCURRENCY). */
    concurrency?: number;
    /** restrict matching to these source ids (default: all usable). */
    sourceIds?: string[];
}

/** One local series of an import job, with its match state and candidates. */
export interface ImportJobSeriesDto {
    path: string;
    name: string;
    chapterCount: number;
    status: string;
    confidence?: MatchConfidence;
    score?: number;
    confirmed: boolean;
    sourceId?: string;
    sourceLabel?: string;
    mangaId?: string;
    mangaTitle?: string;
    candidates: MigrationSuggestion[];
    matchMode?: 'number' | 'ordinal';
    matched?: number;
    localChapters?: number;
    sourceChapters?: number;
    entryId?: number;
    error?: string;
}

/** Dashboard-facing shape of GET /api/import/jobs/current. */
export interface ImportJobStatusDto {
    job: {
        id: number;
        root: string;
        status: ImportJobPhase;
        options: ImportOptionsDto;
        error?: string;
        createdAt: string;
        updatedAt: string;
    };
    counters: {
        total: number;
        matched: number;
        auto: number;
        review: number;
        none: number;
        confirmed: number;
        synced: number;
        failed: number;
    };
    series: ImportJobSeriesDto[];
}

// ---------------------------------------------------------------------------
// WebSocket events (server -> dashboard)
// ---------------------------------------------------------------------------

export type WsEvent =
    | { type: 'job.updated'; job: DownloadJobDto }
    | { type: 'job.removed'; jobId: number }
    | { type: 'library.updated'; entry: LibraryEntryDto }
    | { type: 'schedule.status'; status: ScheduleStatusDto }
    | { type: 'queue.status'; status: QueueStatusDto }
    | { type: 'sources.updated' }
    | ({ type: 'log'; id?: number; level: LogLevel; message: string; at: string } & LogEventMeta);

// ---------------------------------------------------------------------------
// Generic API envelope
// ---------------------------------------------------------------------------

export interface ApiError {
    error: string;
    details?: string;
}
