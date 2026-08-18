/**
 * Minimal REST client for the dashboard.
 */
import type {
    ApiError,
    AppSettingsResponseDto,
    ChapterDto,
    ConnectorsUpdateInfo,
    ConnectorsUpdateStatus,
    DownloadJobDto,
    LibraryChapterDto,
    LibraryEntryDto,
    MangaDto,
    MigrationSuggestion,
    NotificationSettingsDto,
    QueueSettingsDto,
    ScheduleSettingsDto,
    ScheduleStatusDto,
    SourceDto,
    SourceHealthDto,
    DownloadsPageDto
} from '@tanko/shared';

/** Queue counters (GET /api/downloads/status, pause, resume). */
export interface QueueStatusDto {
    paused: boolean;
    active: number;
    queued: number;
}

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

export interface ImportJobSeries {
    path: string;
    name: string;
    chapterCount: number;
    status: string;
    confidence?: 'auto' | 'review' | 'none';
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
    error?: string;
}

/** Dashboard-facing shape of GET /api/import/jobs/current. */
export interface ImportJobStatus {
    job: {
        id: number;
        root: string;
        status: 'scanning' | 'matching' | 'ready' | 'syncing' | 'done' | 'error';
        options: { autoConfirm?: string; autoDownload?: boolean };
        error?: string;
    } | null;
    counters?: {
        total: number; matched: number; auto: number; review: number; none: number;
        confirmed: number; synced: number; failed: number;
    };
    series?: ImportJobSeries[];
}

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    // only declare JSON when there actually is a body, otherwise Fastify tries to
    // parse an empty payload and answers 400 (e.g. DELETE /api/library/:id)
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && init?.body !== null) {
        headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, { ...init, headers });
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
        request<{ started: boolean; targets: number | 'all' }>('/api/sources/health/check', { method: 'POST', body: JSON.stringify(sourceIds ? { sourceIds } : {}) }),
    search: (sourceId: string, query: string) =>
        request<MangaDto[]>(`/api/sources/${encodeURIComponent(sourceId)}/search?q=${encodeURIComponent(query)}`),
    chapters: (sourceId: string, mangaId: string, title: string) =>
        request<ChapterDto[]>(`/api/sources/${encodeURIComponent(sourceId)}/chapters?${qs({ mangaId, title })}`),
    pages: (sourceId: string, mangaId: string, chapterId: string, mangaTitle: string, chapterTitle: string) =>
        request<{ pages: string[] }>(`/api/sources/${encodeURIComponent(sourceId)}/pages?${qs({ mangaId, chapterId, mangaTitle, chapterTitle })}`),
    sourcesUpdateStatus: () => request<ConnectorsUpdateStatus>('/api/sources/update'),
    updateSources: () => request<{ info: ConnectorsUpdateInfo; restart: boolean }>('/api/sources/update', { method: 'POST' }),

    // library
    addToLibrary: (entry: { sourceId: string; mangaId: string; title: string; url?: string; thumbnail?: string; autoDownload?: boolean }) =>
        request<{ entry: LibraryEntryDto; snapshot: number }>('/api/library', { method: 'POST', body: JSON.stringify(entry) }),
    library: (hidden = false) => request<LibraryEntryDto[]>(`/api/library${hidden ? '?hidden=1' : ''}`),
    removeFromLibrary: (entryId: number, disk = false) =>
        request<{ ok: boolean; deletedPath: string | null }>(`/api/library/${entryId}${disk ? '?disk=1' : ''}`, { method: 'DELETE' }),
    setHidden: (entryId: number, hidden: boolean) =>
        request<LibraryEntryDto | null>(`/api/library/${entryId}`, { method: 'PATCH', body: JSON.stringify({ hidden }) }),
    entryDiskPath: (entryId: number) =>
        request<{ path: string | null }>(`/api/library/${entryId}/disk-path`),
    setAutoDownload: (entryId: number, autoDownload: boolean) =>
        request<LibraryEntryDto | null>(`/api/library/${entryId}`, { method: 'PATCH', body: JSON.stringify({ autoDownload }) }),
    entryChapters: (entryId: number) => request<LibraryChapterDto[]>(`/api/library/${entryId}/chapters`),
    checkEntry: (entryId: number) => request<{ newChapters: number }>(`/api/library/${entryId}/check`, { method: 'POST' }),
    downloadNew: (entryId: number) => request<{ queued: number }>(`/api/library/${entryId}/download-new`, { method: 'POST' }),
    entryHistory: (entryId: number) => request<ChapterHistoryEntry[]>(`/api/library/${entryId}/history`),
    rollbackChapter: (entryId: number, chapterId: string) =>
        request<{ ok: boolean }>(`/api/library/${entryId}/chapters/${encodeURIComponent(chapterId)}/rollback`, { method: 'POST' }),
    rematchFailed: () =>
        request<{ started: boolean; count: number; reason?: string }>('/api/library/rematch-failed', { method: 'POST', body: JSON.stringify({}) }),
    rematchEntry: (entryId: number) =>
        request<{ outcome: string; entry: LibraryEntryDto | null }>(`/api/library/${entryId}/rematch`, { method: 'POST' }),
    confirmRematch: (entryId: number, apply: boolean) =>
        request<{ applied: boolean; kept?: number; total?: number; entry?: LibraryEntryDto | null }>(`/api/library/${entryId}/rematch/confirm`, { method: 'POST', body: JSON.stringify({ apply }) }),
    rollbackMigration: (entryId: number) =>
        request<{ ok: boolean; entry: LibraryEntryDto | null }>(`/api/library/${entryId}/migration/rollback`, { method: 'POST' }),

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
    cancelJob: (jobId: number) => request<{ ok: boolean }>(`/api/downloads/${jobId}`, { method: 'DELETE' }),
    pauseQueue: () => request<QueueStatusDto>('/api/downloads/pause', { method: 'POST' }),
    resumeQueue: () => request<QueueStatusDto>('/api/downloads/resume', { method: 'POST' }),

    // schedule
    schedule: () => request<{ settings: ScheduleSettingsDto; status: ScheduleStatusDto }>('/api/schedule'),
    updateSchedule: (patch: SchedulePatch) =>
        request<{ settings: ScheduleSettingsDto; status: ScheduleStatusDto }>('/api/schedule', { method: 'PATCH', body: JSON.stringify(patch) }),
    runSchedule: () => request<{ checked: number; newChapters: number }>('/api/schedule/run', { method: 'POST' }),

    // settings
    settings: () => request<AppSettingsResponseDto>('/api/settings'),
    updateSettings: (patch: Partial<QueueSettingsDto> & { preferredLanguages?: string[] | string; uiLanguage?: 'en' | 'fr'; useFirstChapterCovers?: boolean }) =>
        request<{ queue: QueueSettingsDto; preferredLanguages: string[]; uiLanguage: 'en' | 'fr'; useFirstChapterCovers: boolean }>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

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
