/**
 * Persistent download queue:
 *  - jobs stored in SQLite (survive restarts, resume after crash)
 *  - per-source worker concurrency (parallel sources × parallel chapters), per-domain rate limiting
 *  - page-level retries with backoff
 *  - output: folder of images or CBZ (Hakuneko-compatible layout)
 *  - progress published on the WebSocket event bus
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceAdapter, SourceRegistry } from '@tanko/core';
import { createComicInfoXML, LegacySourceAdapter, randomUserAgent } from '@tanko/core';
import type { DownloadJobDto, DownloadStatus, QueueStatusDto } from '@tanko/shared';
import JSZip from 'jszip';
import type { Database } from '../db.js';
import { withTimeout } from '../util/timeout.js';
import type { EventBus } from '../ws.js';
import type { ChapterPaths } from './paths.js';
import { chapterPaths, type DirectoryLayout, detectMime, outputExists, pageFileName } from './paths.js';
import { DomainGate } from './rate-limiter.js';

/** Human-readable page URL for error messages: 'connector://' payloads are
 *  opaque base64 blobs that bury the real (signed) image URL and wreck the
 *  dashboard layout — decode them and strip the query string instead. */
function describePageUrl(url: string): string {
    if (url.startsWith('connector://')) {
        try {
            const decoded = Buffer.from(new URL(url).searchParams.get('payload') ?? '', 'base64').toString('utf8');
            // createConnectorURI base64-encodes JSON.stringify(payload): most
            // connectors pass the plain image URL string, a few an object
            // carrying it — decode both shapes.
            const parsed: unknown = JSON.parse(decoded);
            const real = typeof parsed === 'string' ? parsed : (parsed as { url?: unknown } | null)?.url;
            if (typeof real === 'string' && real.startsWith('http')) {
                return real.replace(/[?#].*$/, '');
            }
        } catch {
            /* malformed connector URI: fall through to truncation */
        }
        return `${url.slice(0, 64)}…`;
    }
    return url.length > 160 ? `${url.slice(0, 160)}…` : url;
}

/** Map a job row back to enqueue() input (retry paths). */
function toChapterInput(row: JobRow) {
    return {
        sourceId: row.source_id,
        mangaId: row.manga_id,
        mangaTitle: row.manga_title,
        chapterId: row.chapter_id,
        chapterTitle: row.chapter_title,
        entryId: row.entry_id ?? undefined
    };
}

export interface QueueSettings {
    /** Base directory for downloads. */
    dataDirectory: string;
    /** 'source' = <base>/<Source>/<Série>/ (Hakuneko), 'series' = <base>/<Série>/. */
    directoryLayout: DirectoryLayout;
    /** 'img' = folder of images, 'cbz' = comic archive. */
    chapterFormat: 'img' | 'cbz';
    /** Max number of distinct sources downloading at the same time. */
    parallelSources: number;
    /** Max number of chapters downloaded in parallel per source. */
    concurrencyPerSource: number;
    /** Minimum delay (ms) between two requests to the same domain. */
    throttleMs: number;
    /** Days to keep finished jobs (completed/failed/cancelled); 0 keeps them forever. */
    historyRetentionDays?: number;
}

/** SQL filter matching finished jobs (history pruning / manual clearing). */
const FINISHED_JOBS = "status IN ('completed', 'failed', 'cancelled')";

/** Default retention when the setting is absent (older installs, tests). */
const DEFAULT_HISTORY_RETENTION_DAYS = 30;

/** Re-run the automatic pruning once a day. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const USER_AGENT = randomUserAgent();
const PAGE_ATTEMPTS = 3;
/** Max page-list refreshes per chapter: pages fetched through signed URLs
 *  (connector:// payloads with ?expires=…) can go stale mid-chapter. */
const PAGE_LIST_REFRESHES = 2;
/** Overall cap for one chapter's page loop (paused time excluded); getPages is
 *  already bounded by its own per-attempt timeout. */
const CHAPTER_DEADLINE_MS = 20 * 60 * 1000;
/** Past this in-memory zip size, the chapter falls back to the img-folder
 *  layout: giant chapters (artbooks) must not double their RAM footprint. */
const CBZ_MEMORY_GUARD_BYTES = 200 * 1024 * 1024;

/** Statuses that make an existing job ineligible for requeue. */
const ACTIVE_STATUSES = new Set<DownloadStatus>(['completed', 'queued', 'downloading']);

/** Shape of the legacy engine bridge installed on globalThis by core's createEngine(). */
interface EngineGlobal {
    Request: { fetch(request: Request): Promise<Response> };
}

interface JobRow {
    id: number;
    entry_id: number | null;
    source_id: string;
    manga_id: string;
    chapter_id: string;
    manga_title: string;
    chapter_title: string;
    status: DownloadStatus;
    progress: number;
    pages_total: number;
    pages_done: number;
    error: string | null;
    path: string | null;
    created_at: string;
    updated_at: string;
}

export class DownloadQueue {
    private readonly gate: DomainGate;
    private readonly cancelFlags = new Map<number, boolean>();
    private paused = false;
    /** Whether the library table exists in this database — downloads can run
     *  standalone (no library ever initialised), in which case the
     *  migration-orphan filter of retryFailed/retryJob is disabled. */
    private libraryPresent = false;
    /** Running downloads per source id; keys = busy sources (values are always > 0). */
    private readonly activePerSource = new Map<string, number>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private pruneTimer: ReturnType<typeof setInterval> | undefined;

    constructor(
        private readonly opts: {
            db: Database;
            registry: SourceRegistry;
            events: EventBus;
            settings: QueueSettings;
            /** Invoked when a job reaches a terminal state (completed/failed/cancelled). */
            onJobFinished?: (job: DownloadJobDto) => void;
            /** Invoked with the (entry, chapter) pairs of queued jobs removed by
             *  clearQueue(), so the library can restore their chapter status. */
            onJobsCleared?: (pairs: Array<{ entryId: number; chapterId: string }>) => void;
        }
    ) {
        this.gate = new DomainGate(opts.settings.throttleMs);
        this._migrate();
        this._recover();
        this._pruneHistory();
        this.pruneTimer = setInterval(() => this._pruneHistory(), PRUNE_INTERVAL_MS);
        this.timer = setInterval(() => this._schedule(), 1000);
    }

    // ------------------------------------------------------------------
    // public API
    // ------------------------------------------------------------------

    enqueue(
        chapters: Array<{
            sourceId: string;
            mangaId: string;
            mangaTitle: string;
            chapterId: string;
            chapterTitle: string;
            entryId?: number;
        }>
    ): { added: number; skipped: number; retried: number } {
        let added = 0;
        let skipped = 0;
        let retried = 0;
        const now = new Date().toISOString();
        for (const chapter of chapters) {
            const existing = this.opts.db.db
                .prepare('SELECT id, status, entry_id FROM download_jobs WHERE source_id = ? AND manga_id = ? AND chapter_id = ?')
                .get(chapter.sourceId, chapter.mangaId, chapter.chapterId) as { id: number; status: DownloadStatus; entry_id: number | null } | undefined;

            if (existing && ACTIVE_STATUSES.has(existing.status)) {
                // active duplicate: still backfill its entry link when it was queued before the manga was followed
                if (existing.entry_id === null && chapter.entryId != null) {
                    this.opts.db.db.prepare('UPDATE download_jobs SET entry_id = ? WHERE id = ?').run(chapter.entryId, existing.id);
                }
                skipped++;
                continue;
            }
            if (existing) {
                // failed/cancelled job -> requeue (and link it to the library entry if it wasn't)
                this.opts.db.db
                    .prepare(
                        'UPDATE download_jobs SET status = ?, error = NULL, progress = 0, pages_done = 0, entry_id = COALESCE(?, entry_id), updated_at = ? WHERE id = ?'
                    )
                    .run('queued', chapter.entryId ?? null, now, existing.id);
                retried++;
                continue;
            }
            this.opts.db.db
                .prepare(
                    `INSERT INTO download_jobs
                    (entry_id, source_id, manga_id, chapter_id, manga_title, chapter_title, status, progress, pages_total, pages_done, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, ?, ?)`
                )
                .run(chapter.entryId ?? null, chapter.sourceId, chapter.mangaId, chapter.chapterId, chapter.mangaTitle, chapter.chapterTitle, now, now);
            added++;
        }
        this._schedule();
        this._publishStatus();
        return { added, skipped, retried };
    }

    /** One page of jobs (active first) + total matching rows + per-status counts. */
    list(options: { limit?: number; offset?: number; status?: string; query?: string } = {}): {
        jobs: DownloadJobDto[];
        total: number;
        counts: Record<string, number>;
    } {
        const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
        const offset = Math.max(options.offset ?? 0, 0);
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (options.status) {
            where.push('status = ?');
            params.push(options.status);
        }
        if (options.query) {
            where.push('(manga_title LIKE ? OR chapter_title LIKE ?)');
            const like = `%${options.query}%`;
            params.push(like, like);
        }
        const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
        const counts: Record<string, number> = {};
        for (const row of this.opts.db.db.prepare('SELECT status, COUNT(*) AS n FROM download_jobs GROUP BY status').all() as Array<{
            status: string;
            n: number;
        }>) {
            counts[row.status] = row.n;
        }
        const total = Number((this.opts.db.db.prepare(`SELECT COUNT(*) AS n FROM download_jobs${clause}`).get(...params) as { n: number }).n);
        const rows = this.opts.db.db
            .prepare(
                `SELECT * FROM download_jobs${clause} ORDER BY CASE status WHEN 'downloading' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, updated_at DESC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset) as unknown as JobRow[];
        return { jobs: rows.map(row => this._toDto(row)), total, counts };
    }

    cancel(jobId: number): boolean {
        const row = this.opts.db.db.prepare('SELECT id, status FROM download_jobs WHERE id = ?').get(jobId) as
            | { id: number; status: DownloadStatus }
            | undefined;
        if (!row) {
            return false;
        }
        if (row.status === 'queued') {
            this._update(jobId, { status: 'cancelled' });
            return true;
        }
        if (row.status === 'downloading') {
            this.cancelFlags.set(jobId, true);
            return true;
        }
        return false;
    }

    /** Requeue every failed job whose entry (when tracked) still downloads
     *  from the job's source — jobs left behind by a source migration point
     *  at a dead source and must not be resurrected. Returns the requeued
     *  (entryId, chapterId) pairs so the caller can sync the library chapter
     *  statuses back to 'queued'. */
    retryFailed(): { retried: number; chapters: Array<{ entryId: number; chapterId: string }> } {
        const orphanFilter = this.libraryPresent
            ? ` AND (entry_id IS NULL OR EXISTS(SELECT 1 FROM library WHERE library.id = download_jobs.entry_id AND library.source_id = download_jobs.source_id))`
            : '';
        const rows = this.opts.db.db.prepare(`SELECT * FROM download_jobs WHERE status = 'failed'${orphanFilter}`).all() as unknown as JobRow[];
        if (rows.length === 0) {
            return { retried: 0, chapters: [] };
        }
        const { retried } = this.enqueue(rows.map(row => toChapterInput(row)));
        return {
            retried,
            chapters: rows.flatMap(row => (row.entry_id != null ? [{ entryId: row.entry_id, chapterId: row.chapter_id }] : []))
        };
    }

    /** Requeue a single finished job (failed or cancelled). */
    retryJob(jobId: number): { retried: number; chapters: Array<{ entryId: number; chapterId: string }> } {
        const row = this.opts.db.db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined;
        if (!row || (row.status !== 'failed' && row.status !== 'cancelled')) {
            return { retried: 0, chapters: [] };
        }
        if (row.entry_id != null && !this._entryTracksSource(row.entry_id, row.source_id)) {
            return { retried: 0, chapters: [] }; // orphaned by a source migration
        }
        this.enqueue([toChapterInput(row)]);
        return {
            retried: 1,
            chapters: row.entry_id != null ? [{ entryId: row.entry_id, chapterId: row.chapter_id }] : []
        };
    }

    /** Whether the entry still has queued or downloading jobs. The immediate
     *  download-failure failover defers until they settle so a migration does
     *  not race chapters being rebuilt under running downloads. */
    hasPendingJobs(entryId: number): boolean {
        const row = this.opts.db.db
            .prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE entry_id = ? AND status IN ('queued', 'downloading')")
            .get(entryId) as { n: number };
        return row.n > 0;
    }

    /** Whether the library entry (when tracked) still downloads from this
     *  source — jobs orphaned by a source migration must not be retried. */
    private _entryTracksSource(entryId: number, sourceId: string): boolean {
        if (!this.libraryPresent) {
            return true;
        }
        const row = this.opts.db.db.prepare('SELECT 1 AS ok FROM library WHERE id = ? AND source_id = ?').get(entryId, sourceId);
        return row !== undefined;
    }
    pause(): void {
        this.paused = true;
        this._publishStatus();
    }

    resume(): void {
        this.paused = false;
        this._schedule();
        this._publishStatus();
    }

    /** Empty the pending queue: queued jobs are deleted, running ones get the
     *  cancel flag (consumed at the worker's next checkpoint, so they finish
     *  as 'cancelled'). History is left untouched. Chapter statuses of the
     *  removed jobs are restored through onJobsCleared so they do not stay
     *  stuck at 'queued' with no job behind them. */
    clearQueue(): { cancelled: number; removed: number } {
        const active = this.opts.db.db.prepare("SELECT id FROM download_jobs WHERE status = 'downloading'").all() as unknown as Array<{ id: number }>;
        for (const job of active) {
            this.cancelFlags.set(job.id, true);
        }
        const queued = this.opts.db.db.prepare("SELECT id FROM download_jobs WHERE status = 'queued'").all() as unknown as Array<{ id: number }>;
        const pairs = this.opts.db.db
            .prepare("SELECT entry_id AS entryId, chapter_id AS chapterId FROM download_jobs WHERE status = 'queued' AND entry_id IS NOT NULL")
            .all() as unknown as Array<{ entryId: number; chapterId: string }>;
        const removed = Number(this.opts.db.db.prepare("DELETE FROM download_jobs WHERE status = 'queued'").run().changes);
        // tell the dashboard the queued rows are gone (no job.updated will ever fire for them)
        for (const row of queued) {
            this.opts.events.publish({ type: 'job.removed', jobId: row.id });
        }
        if (pairs.length > 0) {
            this.opts.onJobsCleared?.(pairs);
        }
        this._publishStatus();
        return { cancelled: active.length, removed };
    }

    status(): QueueStatusDto {
        const row = this.opts.db.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE status = 'queued'").get() as { n: number };
        const active = [...this.activePerSource.values()].reduce((total, count) => total + count, 0);
        return { paused: this.paused, active, queued: row.n };
    }

    getSettings(): QueueSettings {
        return { ...this.opts.settings, historyRetentionDays: this._retentionDays() };
    }

    updateSettings(patch: Partial<QueueSettings>): QueueSettings {
        const settings = this.opts.settings;
        if (patch.chapterFormat === 'img' || patch.chapterFormat === 'cbz') {
            settings.chapterFormat = patch.chapterFormat;
        }
        // both concurrency knobs share the same validation; _schedule() is idempotent
        for (const key of ['parallelSources', 'concurrencyPerSource'] as const) {
            const value = patch[key];
            if (typeof value === 'number' && value >= 1) {
                settings[key] = Math.floor(value);
                this._schedule();
            }
        }
        if (typeof patch.throttleMs === 'number' && patch.throttleMs >= 0) {
            settings.throttleMs = patch.throttleMs;
            this.gate.setMinInterval(patch.throttleMs);
        }
        if (patch.directoryLayout === 'source' || patch.directoryLayout === 'series') {
            settings.directoryLayout = patch.directoryLayout;
        }
        if (typeof patch.dataDirectory === 'string' && patch.dataDirectory.trim()) {
            const directory = patch.dataDirectory.trim();
            const resolved = path.resolve(directory);
            fs.mkdirSync(resolved, { recursive: true });
            settings.dataDirectory = resolved;
        }
        if (typeof patch.historyRetentionDays === 'number' && patch.historyRetentionDays >= 0) {
            settings.historyRetentionDays = Math.floor(patch.historyRetentionDays);
            this._pruneHistory(); // apply the new limit right away
        }
        return this.getSettings();
    }

    /** Delete every finished job (completed/failed/cancelled); returns the number removed. */
    clearHistory(): number {
        return this._deleteFinished('1 = 1');
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = undefined;
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private _migrate(): void {
        this.libraryPresent = this.opts.db.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'library'").get() !== undefined;
        this.opts.db.db.exec(`
            CREATE TABLE IF NOT EXISTS download_jobs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id      INTEGER,
                source_id     TEXT NOT NULL,
                manga_id      TEXT NOT NULL,
                chapter_id    TEXT NOT NULL,
                manga_title   TEXT NOT NULL,
                chapter_title TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'queued',
                progress      REAL NOT NULL DEFAULT 0,
                pages_total   INTEGER NOT NULL DEFAULT 0,
                pages_done    INTEGER NOT NULL DEFAULT 0,
                error         TEXT,
                path          TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                UNIQUE(source_id, manga_id, chapter_id)
            );
            CREATE INDEX IF NOT EXISTS idx_download_jobs_status ON download_jobs(status);
        `);
    }

    /** After a crash/restart, jobs stuck in queued/downloading go back to queued. */
    private _recover(): void {
        this.opts.db.db
            .prepare("UPDATE download_jobs SET status = ?, updated_at = ? WHERE status IN ('queued', 'downloading')")
            .run('queued', new Date().toISOString());
    }

    /** Effective retention in days (setting absent → default). */
    private _retentionDays(): number {
        return this.opts.settings.historyRetentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS;
    }

    /** Drop finished jobs older than the configured retention; 0 keeps everything. */
    private _pruneHistory(): void {
        const days = this._retentionDays();
        if (days <= 0) {
            return;
        }
        // updated_at is ISO-8601, so a lexicographic cutoff works
        this._deleteFinished(`updated_at < '${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()}'`);
    }

    private _schedule(): void {
        if (this.paused) {
            return;
        }
        const rows = this.opts.db.db.prepare("SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY id ASC").all() as unknown as JobRow[];
        for (const row of rows) {
            const running = this.activePerSource.get(row.source_id) ?? 0;
            // skip while the source already downloads its full share of chapters…
            if (running >= this.opts.settings.concurrencyPerSource) {
                continue;
            }
            // …or while starting it would need a source slot and none is left
            if (running === 0 && this.activePerSource.size >= this.opts.settings.parallelSources) {
                continue;
            }
            this.activePerSource.set(row.source_id, running + 1);
            this._update(row.id, { status: 'downloading' });
            this._runJob(row).finally(() => {
                const remaining = (this.activePerSource.get(row.source_id) ?? 1) - 1;
                if (remaining > 0) {
                    this.activePerSource.set(row.source_id, remaining);
                } else {
                    this.activePerSource.delete(row.source_id);
                }
                this._schedule();
            });
        }
    }

    private async _runJob(row: JobRow): Promise<void> {
        try {
            const source = await this.opts.registry.get(row.source_id);
            if (!source) {
                throw new Error(`Source "${row.source_id}" not found`);
            }

            const pages = await this._getPageListWithRetries(source, row);

            const paths = chapterPaths(this.opts.settings.dataDirectory, source.label, row.manga_title, row.chapter_title, this.opts.settings.directoryLayout);
            const isCbz = this.opts.settings.chapterFormat === 'cbz';
            const output = isCbz ? paths.cbzFile : paths.directory;

            // already downloaded -> mark completed without re-downloading
            if (outputExists(paths, isCbz ? 'cbz' : 'img', pages.length)) {
                this._update(row.id, {
                    status: 'completed',
                    progress: 100,
                    pages_total: pages.length,
                    pages_done: pages.length,
                    path: paths.existing ?? output
                });
                return;
            }

            this._update(row.id, { pages_total: pages.length });
            const zip = isCbz ? new JSZip() : undefined;
            if (!isCbz) {
                fs.mkdirSync(paths.directory, { recursive: true });
            }
            const { mode, pageCount } = await this._downloadPages(row, pages, source, paths, zip);
            if (mode === 'cbz' && zip) {
                await this._finalizeCbz(zip, paths, row.manga_title, row.chapter_title, pageCount);
            }

            this._update(row.id, { status: 'completed', progress: 100, path: mode === 'cbz' ? paths.cbzFile : paths.directory });
        } catch (error: unknown) {
            // _checkCancel() aborts a job by throwing Error('cancelled');
            // matching by message (not instanceof) is the tested contract.
            const message = (error as { message?: unknown })?.message;
            const cancelled = message === 'cancelled';
            this._update(row.id, {
                status: cancelled ? 'cancelled' : 'failed',
                progress: 100,
                error: cancelled ? undefined : String(message || error)
            });
        } finally {
            // a cancel flag set just before an unrelated failure would
            // otherwise linger in the Map forever
            this.cancelFlags.delete(row.id);
            this._notifyFinished(row.id);
        }
    }

    /** Download every page to the output folder (or in-memory zip), publishing progress.
     *   Returns the mode actually used: a CBZ chapter whose pages outgrow the
     *   memory guard is flushed to the img directory mid-flight and stays 'img'.
     *   Pages served through signed URLs that expire mid-chapter are recovered
     *   by refreshing the page list (fresh URLs) and retrying the same index. */
    private async _downloadPages(
        row: JobRow,
        pages: string[],
        source: SourceAdapter,
        paths: ChapterPaths,
        zip: JSZip | undefined
    ): Promise<{ mode: 'cbz' | 'img'; pageCount: number }> {
        let leadingZeroes = String(pages.length).length;
        const startedAt = Date.now();
        let pausedMs = 0;
        let archive = zip;
        let archiveBytes = 0;
        let refreshesLeft = PAGE_LIST_REFRESHES;
        for (let index = 0; index < pages.length; index++) {
            this._checkCancel(row.id);
            const pauseStart = Date.now();
            await this._waitWhilePaused();
            pausedMs += Date.now() - pauseStart;
            this._checkCancel(row.id);
            if (Date.now() - startedAt - pausedMs > CHAPTER_DEADLINE_MS) {
                throw new Error(`chapter download timed out after ${Math.round(CHAPTER_DEADLINE_MS / 60000)}min (${index}/${pages.length} pages)`);
            }

            let page: { mime: string; data: Uint8Array };
            try {
                page = await this._fetchPageWithRetries(pages[index], source);
            } catch (error) {
                // Signed image URLs (connector:// payloads carrying ?acc=…&expires=…)
                // go stale while the chapter downloads: the CDN then answers with a
                // tiny HTML error page that retrying the same URL can never fix.
                // Refresh the page list for a fresh set of URLs and retry once.
                if (refreshesLeft <= 0) {
                    throw error;
                }
                refreshesLeft--;
                let fresh: string[];
                try {
                    fresh = await this._getPageListWithRetries(source, row);
                } catch (refreshError) {
                    if ((refreshError as Error)?.message === 'cancelled') {
                        throw refreshError;
                    }
                    throw new Error(`${(error as Error).message} (page-list refresh failed: ${(refreshError as Error).message})`);
                }
                if (index >= fresh.length) {
                    throw error; // the chapter shrank server-side: don't guess a mapping
                }
                if (fresh.length !== pages.length) {
                    this._update(row.id, { pages_total: fresh.length });
                }
                pages = fresh;
                // the refreshed list may be longer: keep zero-padding in step
                leadingZeroes = String(pages.length).length;
                page = await this._fetchPageWithRetries(pages[index], source);
            }
            const { mime, data } = page;
            const fileName = pageFileName(index + 1, mime, leadingZeroes);
            if (archive) {
                archiveBytes += data.length;
                if (archiveBytes > CBZ_MEMORY_GUARD_BYTES) {
                    await this._spillArchiveToDirectory(archive, paths, row.id);
                    archive = undefined;
                }
            }
            if (archive) {
                archive.file(fileName, Buffer.from(data));
            } else {
                fs.writeFileSync(path.join(paths.directory, fileName), Buffer.from(data));
            }

            this._update(row.id, {
                pages_done: index + 1,
                progress: Math.round(((index + 1) / pages.length) * 100)
            });
        }
        return { mode: archive ? 'cbz' : 'img', pageCount: pages.length };
    }

    /** Memory guard tripped: write every buffered zip entry to the img directory
     *   and drop the archive; the rest of the chapter lands on disk directly. */
    private async _spillArchiveToDirectory(zip: JSZip, paths: ChapterPaths, jobId: number): Promise<void> {
        this.opts.events.publish({
            type: 'log',
            level: 'warn',
            message: `Chapter exceeds the in-memory CBZ budget — saved as an image folder instead (job #${jobId})`,
            at: new Date().toISOString()
        });
        fs.mkdirSync(paths.directory, { recursive: true });
        for (const file of Object.values(zip.files)) {
            if (!file.dir) {
                fs.writeFileSync(path.join(paths.directory, file.name), await file.async('nodebuffer'));
            }
        }
    }

    /** Write the CBZ archive (ComicInfo.xml + downloaded pages) to disk. */
    private async _finalizeCbz(zip: JSZip, paths: ChapterPaths, mangaTitle: string, chapterTitle: string, pageCount: number): Promise<void> {
        zip.file('ComicInfo.xml', createComicInfoXML(mangaTitle, chapterTitle, pageCount));
        fs.mkdirSync(path.dirname(paths.cbzFile), { recursive: true });
        const buffer = await zip.generateAsync({ compression: 'STORE', type: 'nodebuffer' });
        fs.writeFileSync(paths.cbzFile, buffer);
        // integrity check: the archive must re-open and hold every page. A
        // corrupt file is removed so a later run retries instead of treating
        // it as "already downloaded".
        try {
            const reread = await JSZip.loadAsync(fs.readFileSync(paths.cbzFile));
            const entries = Object.values(reread.files).filter(file => !file.dir && file.name !== 'ComicInfo.xml');
            if (entries.length !== pageCount) {
                throw new Error(`archive incohérente : ${entries.length}/${pageCount} pages`);
            }
        } catch (error) {
            try {
                fs.unlinkSync(paths.cbzFile);
            } catch {
                /* already gone */
            }
            throw new Error(`CBZ invalide après écriture : ${(error as Error).message}`);
        }
    }

    private _notifyFinished(jobId: number): void {
        if (!this.opts.onJobFinished) {
            return;
        }
        const row = this.opts.db.db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId) as unknown as JobRow;
        if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
            this.opts.onJobFinished(this._toDto(row));
        }
    }

    /**
     * Page lists can fail intermittently (protected chapter scripts, rate
     * limiting, transient anti-bot pages) — retry with backoff before
     * failing the whole job.
     */
    private async _getPageListWithRetries(source: SourceAdapter, row: JobRow): Promise<Awaited<ReturnType<SourceAdapter['getPages']>>> {
        let lastError: unknown;
        for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
            // throws Error('cancelled') — must propagate untouched (job status contract)
            this._checkCancel(row.id);
            try {
                const pages = await withTimeout(
                    source.getPages({ id: row.manga_id, title: row.manga_title }, { id: row.chapter_id, title: row.chapter_title }),
                    90 * 1000,
                    `getPages(${row.manga_title} - ${row.chapter_title})`
                );
                if (!pages.length) {
                    throw new Error('Page list is empty');
                }
                return pages;
            } catch (error) {
                if ((error as Error)?.message === 'cancelled') {
                    throw error;
                }
                lastError = error;
                if (attempt < PAGE_ATTEMPTS - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
                }
            }
        }
        throw new Error(`Failed to get page list: ${String((lastError as Error)?.message || lastError)}`);
    }

    private async _fetchPageWithRetries(url: string, source: SourceAdapter): Promise<{ mime: string; data: Uint8Array }> {
        let lastError: unknown;
        for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
            try {
                await this.gate.pass(url);
                const page = await this._fetchPage(url, source);
                // a "successfully" fetched page that is not an image (HTML error
                // page, cloudflare challenge, JSON error) must not end up in the
                // chapter: treat it as a failure so the retry/backoff kicks in
                if (!page.mime.toLowerCase().startsWith('image/')) {
                    throw new Error(`non-image page (${page.mime}, ${page.data.length} bytes)`);
                }
                return page;
            } catch (error) {
                lastError = error;
                if (attempt < PAGE_ATTEMPTS - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
                }
            }
        }
        throw new Error(`Failed to download page "${describePageUrl(url)}": ${String((lastError as Error)?.message || lastError)}`);
    }

    private async _fetchPage(url: string, source: SourceAdapter): Promise<{ mime: string; data: Uint8Array }> {
        let response: Response;
        if (url.startsWith('connector://')) {
            // routed to the owning connector by the global fetch wrapper
            response = await fetch(url);
        } else if (source instanceof LegacySourceAdapter) {
            // apply legacy x-* header transformations + cookie jar via the legacy engine bridge
            const engine = (globalThis as unknown as { Engine: EngineGlobal }).Engine;
            const request = new Request(url, source.connector.requestOptions);
            response = await engine.Request.fetch(request);
        } else {
            let referer: string;
            if (url.startsWith('http') && source.url) {
                referer = `${source.url}/`;
            } else {
                referer = source.url || url;
            }
            response = await fetch(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
                    Referer: referer
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(120000)
            });
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const mime = detectMime(data, response.headers.get('content-type') || 'image/');
        return { mime, data };
    }

    private _checkCancel(jobId: number): void {
        if (this.cancelFlags.get(jobId)) {
            this.cancelFlags.delete(jobId);
            throw new Error('cancelled');
        }
    }

    private async _waitWhilePaused(): Promise<void> {
        while (this.paused) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private _update(jobId: number, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'pages_total' | 'pages_done' | 'error' | 'path'>>): void {
        const fields: string[] = [];
        const values: (string | number | null)[] = [];
        for (const [key, value] of Object.entries(patch)) {
            if (value !== undefined) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        fields.push('updated_at = ?');
        values.push(new Date().toISOString(), jobId);
        this.opts.db.db.prepare(`UPDATE download_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        const row = this.opts.db.db.prepare('SELECT * FROM download_jobs WHERE id = ?').get(jobId) as unknown as JobRow;
        this.opts.events.publish({ type: 'job.updated', job: this._toDto(row) });
        // status transitions change the queue counters — push them with the job
        if (patch.status !== undefined) {
            this._publishStatus();
        }
    }

    /** Shared delete for finished jobs (history clear + retention prune):
     *  drops the rows and notifies WS clients via job.removed. */
    private _deleteFinished(where: string): number {
        const ids = (this.opts.db.db.prepare(`SELECT id FROM download_jobs WHERE ${FINISHED_JOBS} AND ${where}`).all() as unknown as Array<{ id: number }>).map(
            row => row.id
        );
        if (ids.length === 0) {
            return 0;
        }
        const removed = Number(this.opts.db.db.prepare(`DELETE FROM download_jobs WHERE ${FINISHED_JOBS} AND ${where}`).run().changes);
        for (const id of ids) {
            this.opts.events.publish({ type: 'job.removed', jobId: id });
        }
        return removed;
    }

    /** Push the authoritative queue counters (paused/active/queued) to WS clients. */
    private _publishStatus(): void {
        this.opts.events.publish({ type: 'queue.status', status: this.status() });
    }

    private _toDto(row: JobRow): DownloadJobDto {
        return {
            id: row.id,
            entryId: row.entry_id,
            sourceId: row.source_id,
            mangaId: row.manga_id,
            chapterId: row.chapter_id,
            mangaTitle: row.manga_title,
            chapterTitle: row.chapter_title,
            status: row.status,
            progress: Math.round(row.progress),
            pagesTotal: row.pages_total,
            pagesDone: row.pages_done,
            error: row.error || undefined,
            path: row.path || undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}
