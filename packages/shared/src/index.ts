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
// Library
// ---------------------------------------------------------------------------

/** Suggested source migration (awaiting user confirmation). */
export interface MigrationSuggestion {
    sourceId: string;
    sourceLabel: string;
    mangaId: string;
    mangaTitle: string;
    score: number;
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
    lastCheckedAt?: string;
    addedAt: string;
    /** Consecutive failed checks against the current source. */
    checkFailures?: number;
    /** Suggested source migration (awaiting user confirmation). */
    migrationSuggestion?: MigrationSuggestion;
    /** A migration snapshot exists -> the last source change can be undone. */
    canRollbackMigration?: boolean;
    /** Hidden entries stay out of the default library list and the scheduler. */
    hidden?: boolean;
}

export interface LibraryChapterDto {
    id: number;
    entryId: number;
    chapterId: string;
    title: string;
    language?: string;
    status: 'new' | 'missing' | 'queued' | 'downloading' | 'downloaded' | 'failed';
    path?: string;
    discoveredAt: string;
    downloadedAt?: string;
    /** Number of history entries (path/status changes) for this chapter. */
    historyCount?: number;
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
    /** Number of chapters downloaded in parallel. */
    concurrency: number;
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
    diskUsedBytes: number;
}

export interface NotificationSettingsDto {
    enabled: boolean;
    webhookUrl: string;
}

// ---------------------------------------------------------------------------
// WebSocket events (server -> dashboard)
// ---------------------------------------------------------------------------

export type WsEvent =
    | { type: 'job.updated'; job: DownloadJobDto }
    | { type: 'job.removed'; jobId: number }
    | { type: 'library.updated'; entry: LibraryEntryDto }
    | { type: 'schedule.status'; status: ScheduleStatusDto }
    | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string; at: string };

// ---------------------------------------------------------------------------
// Generic API envelope
// ---------------------------------------------------------------------------

export interface ApiError {
    error: string;
    details?: string;
}
