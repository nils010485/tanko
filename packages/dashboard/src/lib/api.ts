/**
 * Minimal REST client for the dashboard.
 */
import type {
    ActivityJobsDto,
    ActivityLogDto,
    ActivityStatsDto,
    ApiError,
    AppSettingsResponseDto,
    ChapterDto,
    ConnectorsUpdateInfo,
    ConnectorsUpdateStatus,
    DeadSeriesDto,
    DownloadsPageDto,
    GlobalSearchStatusDto,
    ImportJobStatusDto,
    LibraryBulkAction,
    LibraryBulkSummary,
    LibraryChapterDto,
    LibraryEntryDto,
    MangaDto,
    NotificationSettingsDto,
    QueueSettingsDto,
    QueueStatusDto,
    ScheduleSettingsDto,
    ScheduleStatusDto,
    SourceAlternativeDto,
    SourceAlternativesResponseDto,
    SourceDto,
    SourceHealthDto
} from '@tanko/shared';

export type { QueueStatusDto };

/** First-chapter cover cache status (GET /api/library/covers/status). */
export interface CoverStatusDto {
    enabled: boolean;
    running: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
}

/** One row of the server's chapter change history (chapter_history table). */
export interface ChapterHistoryEntry {
    id: number;
    entry_id: number;
    chapter_id: string;
    title: string;
    event: string;
    old_status: string | null;
    old_path: string | null;
    new_status: string | null;
    new_path: string | null;
    at: string;
}

/** One local series of an import job (shared DTO, exposed for the Import view). */
export type ImportJobSeries = ImportJobStatusDto['series'][number];

/** Dashboard-facing shape of GET /api/import/jobs/current: the server answers
 *  { job: null } when no job ever ran, and omits counters/series while the
 *  first scan is still running. */
export type ImportJobStatus = Partial<Omit<ImportJobStatusDto, 'job'>> & { job: ImportJobStatusDto['job'] | null };

/** Response of POST /api/import/scan. */
export interface ImportScanResult {
    root: string;
    totalChapters: number;
    truncated: boolean;
    series: Array<{
        name: string;
        path: string;
        chapterCount: number;
        metaName?: string;
        numbers: number[];
        sample: string[];
    }>;
}

/** Build a query string (all values URL-encoded). */
function qs(params: Record<string, string>): string {
    return new URLSearchParams(params).toString();
}

/** Boot token (CSRF guard): random per server boot, readable same-origin only
 *  via GET /api/bootstrap. Attached to every request; '' when the server has none. */
let bootToken: string | null = null;
let bootTokenPromise: Promise<string> | null = null;

export function getBootToken(): Promise<string> {
    bootTokenPromise ??= fetch('/api/bootstrap')
        .then(response => (response.ok ? response.json() : { token: '' }))
        .then((body: { token?: string }) => (bootToken = body.token ?? ''))
        .catch(() => (bootToken = ''));
    return bootTokenPromise;
}

/** Forget the memoized token — the server restarted and rotated it. */
export function resetBootToken(): void {
    bootToken = null;
    bootTokenPromise = null;
}

async function request<T>(url: string, init?: RequestInit, retried = false): Promise<T> {
    // only declare JSON when there actually is a body, otherwise Fastify tries to
    // parse an empty payload and answers 400 (e.g. DELETE /api/library/:id)
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && init?.body !== null) {
        headers.set('Content-Type', 'application/json');
    }
    const token = await getBootToken();
    if (token) {
        headers.set('x-tanko-token', token);
    }
    const response = await fetch(url, { ...init, headers });
    if (response.status === 403 && !retried) {
        // token rotated (server restart) or bootstrap failed earlier: refetch and retry once
        resetBootToken();
        return request<T>(url, init, true);
    }
    if (!response.ok) {
        const body: ApiError | null = await response.json().catch(() => null);
        throw new Error(body?.error || `HTTP ${response.status}`);
    }
    return response.json();
}

/** PATCH /api/schedule payload. */
export type SchedulePatch = Partial<Omit<ScheduleSettingsDto, 'notifications'>> & { notifications?: Partial<NotificationSettingsDto> };

export const api = {
    // sources
    sources: () => request<SourceDto[]>('/api/sources'),
    sourceHealth: () => request<Record<string, SourceHealthDto>>('/api/sources/health'),
    hideBroken: () => request<{ hidden: number }>('/api/sources/hide-broken', { method: 'POST' }),
    checkSources: (sourceIds?: string[]) =>
        request<{ started: boolean; targets: number | 'all' }>('/api/sources/health/check', {
            method: 'POST',
            body: JSON.stringify(sourceIds ? { sourceIds } : {})
        }),
    search: (sourceId: string, query: string) => request<MangaDto[]>(`/api/sources/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(query)}`),
    searchAll: (query: string) =>
        request<{ jobId: number; targets: number }>('/api/sources/search-all', { method: 'POST', body: JSON.stringify({ q: query }) }),
    globalSearch: (jobId: number) => request<GlobalSearchStatusDto>(`/api/sources/search-all/${jobId}`),
    chapters: (sourceId: string, mangaId: string, title: string) =>
        request<ChapterDto[]>(`/api/sources/${encodeURIComponent(sourceId)}/chapters?${qs({ mangaId, title })}`),
    pages: (sourceId: string, mangaId: string, chapterId: string, mangaTitle: string, chapterTitle: string) =>
        request<{ pages: string[] }>(`/api/sources/${encodeURIComponent(sourceId)}/pages?${qs({ mangaId, chapterId, mangaTitle, chapterTitle })}`),
    sourcesUpdateStatus: () => request<ConnectorsUpdateStatus>('/api/sources/update'),
    updateSources: () => request<{ info: ConnectorsUpdateInfo; restart: boolean }>('/api/sources/update', { method: 'POST' }),

    // library
    addToLibrary: (entry: {
        sourceId: string;
        mangaId: string;
        title: string;
        url?: string;
        thumbnail?: string;
        autoDownload?: boolean;
        backlog?: 'ignore' | 'grab';
    }) => request<{ entry: LibraryEntryDto; snapshot: number; queued?: number }>('/api/library', { method: 'POST', body: JSON.stringify(entry) }),
    library: (hidden = false) => request<LibraryEntryDto[]>(`/api/library${hidden ? '?hidden=1' : ''}`),
    removeFromLibrary: (entryId: number, disk = false) =>
        request<{ ok: boolean; deletedPath: string | null }>(`/api/library/${entryId}${disk ? '?disk=1' : ''}`, { method: 'DELETE' }),
    rescanLibrary: () => request<{ dead: DeadSeriesDto[]; attached: number; entries: number; checked: number }>('/api/library/rescan', { method: 'POST' }),
    pruneLibrary: (ids: number[]) => request<{ removed: number }>('/api/library/prune', { method: 'POST', body: JSON.stringify({ ids }) }),
    setHidden: (entryId: number, hidden: boolean) =>
        request<LibraryEntryDto | null>(`/api/library/${entryId}`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
    setPaused: (entryId: number, paused: boolean) =>
        request<LibraryEntryDto | null>(`/api/library/${entryId}`, { method: 'PATCH', body: JSON.stringify({ paused }) }),
    bulkLibrary: (ids: number[], action: LibraryBulkAction, disk = false) =>
        request<LibraryBulkSummary>('/api/library/bulk', {
            method: 'POST',
            body: JSON.stringify({ ids, action, disk })
        }),
    entryDiskPath: (entryId: number) => request<{ path: string | null }>(`/api/library/${entryId}/disk-path`),
    setAutoDownload: (entryId: number, autoDownload: boolean) =>
        request<LibraryEntryDto | null>(`/api/library/${entryId}`, { method: 'PATCH', body: JSON.stringify({ autoDownload }) }),
    entryChapters: (entryId: number) => request<LibraryChapterDto[]>(`/api/library/${entryId}/chapters`),
    checkEntry: (entryId: number) => request<{ newChapters: number }>(`/api/library/${entryId}/check`, { method: 'POST' }),
    downloadNew: (entryId: number) => request<{ queued: number }>(`/api/library/${entryId}/download-new`, { method: 'POST' }),
    downloadAllNew: () => request<{ queued: number; entries: number }>('/api/library/download-new', { method: 'POST' }),
    downloadAllMissing: () => request<{ queued: number; entries: number }>('/api/library/download-missing', { method: 'POST' }),
    entryHistory: (entryId: number) => request<ChapterHistoryEntry[]>(`/api/library/${entryId}/history`),
    rollbackChapter: (entryId: number, chapterId: string) =>
        request<{ ok: boolean }>(`/api/library/${entryId}/chapters/${encodeURIComponent(chapterId)}/rollback`, { method: 'POST' }),
    rematchFailed: () =>
        request<{ started: boolean; count: number; reason?: string }>('/api/library/rematch-failed', { method: 'POST', body: JSON.stringify({}) }),
    rematchIncomplete: (maxChapters: number) =>
        request<{ started: boolean; count: number; reason?: string }>('/api/library/rematch-incomplete', {
            method: 'POST',
            body: JSON.stringify({ maxChapters })
        }),
    rematchEntry: (entryId: number) => request<{ outcome: string; entry: LibraryEntryDto | null }>(`/api/library/${entryId}/rematch`, { method: 'POST' }),
    confirmRematch: (entryId: number, apply: boolean) =>
        request<{ applied: boolean; kept?: number; total?: number; entry?: LibraryEntryDto | null }>(`/api/library/${entryId}/rematch/confirm`, {
            method: 'POST',
            body: JSON.stringify({ apply })
        }),
    rollbackMigration: (entryId: number) =>
        request<{ ok: boolean; entry: LibraryEntryDto | null }>(`/api/library/${entryId}/migration/rollback`, { method: 'POST' }),
    entryAlternatives: (entryId: number) => request<SourceAlternativesResponseDto>(`/api/library/${entryId}/alternatives`),
    migrateToSource: (entryId: number, target: SourceAlternativeDto) =>
        request<{ kept: number; total: number; entry: LibraryEntryDto | null }>(`/api/library/${entryId}/migrate`, {
            method: 'POST',
            body: JSON.stringify(target)
        }),
    updateAliases: (entryId: number, aliases: string[]) =>
        request<{ entry: LibraryEntryDto | null }>(`/api/library/${entryId}/aliases`, { method: 'PUT', body: JSON.stringify({ aliases }) }),
    fetchAliases: (entryId: number) =>
        request<{ entry: LibraryEntryDto | null; fetched: string[] }>(`/api/library/${entryId}/aliases/fetch`, { method: 'POST' }),

    // downloads
    downloads: (params: { limit?: number; offset?: number; status?: string; q?: string } = {}) => {
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(params)) {
            // undefined/empty values must not reach the query string — they
            // would be stringified as "undefined" and filter everything out
            if (value !== undefined && value !== null && value !== '') {
                query[key] = String(value);
            }
        }
        return request<DownloadsPageDto>(`/api/downloads?${qs(query)}`);
    },
    downloadStatus: () => request<QueueStatusDto>('/api/downloads/status'),
    enqueue: (payload: { sourceId: string; mangaId: string; mangaTitle?: string; chapters: Array<{ id: string; title: string }> }) =>
        request<{ added: number; skipped: number; retried: number }>('/api/downloads', { method: 'POST', body: JSON.stringify(payload) }),
    // Cancel (queued/downloading) or dismiss from history (finished) a single job
    removeJob: (jobId: number) => request<{ ok: boolean }>(`/api/downloads/${jobId}`, { method: 'DELETE' }),
    retryJob: (jobId: number) => request<{ retried: number }>(`/api/downloads/${jobId}/retry`, { method: 'POST' }),
    retryFailed: () => request<{ retried: number }>('/api/downloads/retry', { method: 'POST' }),
    clearHistory: (status?: 'completed' | 'failed' | 'cancelled') =>
        request<{ removed: number }>(`/api/downloads/history${status ? `?status=${status}` : ''}`, { method: 'DELETE' }),
    pauseQueue: () => request<QueueStatusDto>('/api/downloads/pause', { method: 'POST' }),
    resumeQueue: () => request<QueueStatusDto>('/api/downloads/resume', { method: 'POST' }),
    clearQueue: () => request<{ cancelled: number; removed: number } & QueueStatusDto>('/api/downloads/clear', { method: 'POST' }),

    // activity
    activity: (params: { limit?: number; offset?: number } = {}) => {
        const search = new URLSearchParams();
        if (params.limit) {
            search.set('limit', String(params.limit));
        }
        if (params.offset) {
            search.set('offset', String(params.offset));
        }
        const query = search.toString();
        return request<{ logs: ActivityLogDto[] }>(`/api/activity${query ? `?${query}` : ''}`);
    },
    activityStats: (since?: string) => request<ActivityStatsDto>(`/api/activity/stats${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    activityJobs: () => request<ActivityJobsDto>('/api/activity/jobs'),
    cancelJob: (jobId: number) => request<{ ok: boolean }>(`/api/activity/jobs/${jobId}/cancel`, { method: 'POST' }),

    // schedule
    schedule: () => request<{ settings: ScheduleSettingsDto; status: ScheduleStatusDto }>('/api/schedule'),
    updateSchedule: (patch: SchedulePatch) =>
        request<{ settings: ScheduleSettingsDto; status: ScheduleStatusDto }>('/api/schedule', { method: 'PATCH', body: JSON.stringify(patch) }),
    runSchedule: () => request<{ checked: number; newChapters: number; alreadyRunning?: boolean }>('/api/schedule/run', { method: 'POST' }),
    // settings
    settings: () => request<AppSettingsResponseDto>('/api/settings'),
    updateSettings: (
        patch: Partial<QueueSettingsDto> & {
            preferredLanguages?: string[] | string;
            uiLanguage?: 'en' | 'fr';
            useFirstChapterCovers?: boolean;
            incompleteSourceDetection?: boolean;
            stalledSourceDetection?: boolean;
            autoMigrateExactMatch?: boolean;
        }
    ) =>
        request<{
            queue: QueueSettingsDto;
            preferredLanguages: string[];
            uiLanguage: 'en' | 'fr';
            useFirstChapterCovers: boolean;
            incompleteSourceDetection: boolean;
            stalledSourceDetection: boolean;
            autoMigrateExactMatch: boolean;
        }>('/api/settings', {
            method: 'PATCH',
            body: JSON.stringify(patch)
        }),

    // first-chapter cover cache
    coversStatus: () => request<CoverStatusDto>('/api/library/covers/status'),
    regenCovers: () => request<{ started: boolean }>('/api/library/covers/regenerate', { method: 'POST' }),

    // import (preview scan + server-side persistent jobs)
    importScan: (path: string) => request<ImportScanResult>('/api/import/scan', { method: 'POST', body: JSON.stringify({ path }) }),
    importJobStart: (payload: { path: string; autoConfirm?: 'auto' | 'all' | 'none'; autoDownload?: boolean; sourceIds?: string[] }) =>
        request<{ jobId: number }>('/api/import/jobs', { method: 'POST', body: JSON.stringify(payload) }),
    importJobStatus: () => request<ImportJobStatus>('/api/import/jobs/current'),
    importJobResume: (jobId: number) => request<void>(`/api/import/jobs/${jobId}/resume`, { method: 'POST' }),
    importJobCancel: (jobId: number) => request<{ ok: boolean }>(`/api/import/jobs/${jobId}/cancel`, { method: 'POST' }),
    importJobConfirm: (jobId: number, mode: 'auto' | 'all') =>
        request<{ confirmed: number }>(`/api/import/jobs/${jobId}/confirm`, { method: 'POST', body: JSON.stringify({ mode }) }),
    importJobChoose: (jobId: number, payload: { path: string; sourceId: string; sourceLabel: string; mangaId: string; mangaTitle: string }) =>
        request<{ ok: boolean }>(`/api/import/jobs/${jobId}/choose`, { method: 'POST', body: JSON.stringify(payload) }),
    importJobSync: (jobId: number) => request<void>(`/api/import/jobs/${jobId}/sync`, { method: 'POST' })
};

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
