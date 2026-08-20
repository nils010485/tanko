/**
 * Persistent download queue:
 *  - jobs stored in SQLite (survive restarts, resume after crash)
 *  - configurable worker concurrency, per-domain rate limiting
 *  - page-level retries with backoff
 *  - output: folder of images or CBZ (Hakuneko-compatible layout)
 *  - progress published on the WebSocket event bus
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceAdapter, SourceRegistry } from '@tanko/core';
import { createComicInfoXML, LegacySourceAdapter, randomUserAgent } from '@tanko/core';
import type { DownloadJobDto, DownloadStatus } from '@tanko/shared';
import JSZip from 'jszip';
import type { Database } from '../db.js';
import type { EventBus } from '../ws.js';
import type { ChapterPaths } from './paths.js';
import { chapterPaths, type DirectoryLayout, detectMime, outputExists, pageFileName } from './paths.js';
import { DomainGate } from './rate-limiter.js';

export interface QueueSettings {
    /** Base directory for downloads. */
    dataDirectory: string;
    /** 'source' = <base>/<Source>/<Série>/ (Hakuneko), 'series' = <base>/<Série>/. */
    directoryLayout: DirectoryLayout;
    /** 'img' = folder of images, 'cbz' = comic archive. */
    chapterFormat: 'img' | 'cbz';
    /** Number of chapters downloaded in parallel. */
    concurrency: number;
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
    private active = 0;
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

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
        this._schedule();
    }

    /** Empty the pending queue: queued jobs are deleted, running ones get the
     *  cancel flag (consumed at the worker's next checkpoint, so they finish
     *  as 'cancelled'). History is left untouched. */
    clearQueue(): { cancelled: number; removed: number } {
        const active = this.opts.db.db.prepare("SELECT id FROM download_jobs WHERE status = 'downloading'").all() as unknown as Array<{ id: number }>;
        for (const job of active) {
            this.cancelFlags.set(job.id, true);
        }
        const removed = Number(this.opts.db.db.prepare("DELETE FROM download_jobs WHERE status = 'queued'").run().changes);
        return { cancelled: active.length, removed };
    }

    status(): { paused: boolean; active: number; queued: number } {
        const row = this.opts.db.db.prepare("SELECT COUNT(*) AS n FROM download_jobs WHERE status = 'queued'").get() as { n: number };
        return { paused: this.paused, active: this.active, queued: row.n };
    }

    getSettings(): QueueSettings {
        return { ...this.opts.settings, historyRetentionDays: this._retentionDays() };
    }

    updateSettings(patch: Partial<QueueSettings>): QueueSettings {
        const settings = this.opts.settings;
        if (patch.chapterFormat === 'img' || patch.chapterFormat === 'cbz') {
            settings.chapterFormat = patch.chapterFormat;
        }
        if (typeof patch.concurrency === 'number' && patch.concurrency >= 1) {
            settings.concurrency = Math.floor(patch.concurrency);
            this._schedule();
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
        return Number(this.opts.db.db.prepare(`DELETE FROM download_jobs WHERE ${FINISHED_JOBS}`).run().changes);
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
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        this.opts.db.db.prepare(`DELETE FROM download_jobs WHERE ${FINISHED_JOBS} AND updated_at < ?`).run(cutoff);
    }

    private _schedule(): void {
        if (this.paused) {
            return;
        }
        while (this.active < this.opts.settings.concurrency) {
            const row = this.opts.db.db.prepare("SELECT * FROM download_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get() as JobRow | undefined;
            if (!row) {
                break;
            }
            this.active++;
            this._update(row.id, { status: 'downloading' });
            this._runJob(row).finally(() => {
                this.active--;
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
            if (outputExists(paths, isCbz ? 'cbz' : 'img')) {
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
            await this._downloadPages(row.id, pages, source, paths, zip);
            if (zip) {
                await this._finalizeCbz(zip, paths, row.manga_title, row.chapter_title, pages.length);
            }

            this._update(row.id, { status: 'completed', progress: 100, path: output });
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
            this._notifyFinished(row.id);
        }
    }

    /** Download every page to the output folder (or in-memory zip), publishing progress. */
    private async _downloadPages(jobId: number, pages: string[], source: SourceAdapter, paths: ChapterPaths, zip: JSZip | undefined): Promise<void> {
        const leadingZeroes = String(pages.length).length;
        for (let index = 0; index < pages.length; index++) {
            this._checkCancel(jobId);
            await this._waitWhilePaused();
            this._checkCancel(jobId);

            const { mime, data } = await this._fetchPageWithRetries(pages[index], source);
            const fileName = pageFileName(index + 1, mime, leadingZeroes);
            if (zip) {
                zip.file(fileName, Buffer.from(data));
            } else {
                fs.writeFileSync(path.join(paths.directory, fileName), Buffer.from(data));
            }

            this._update(jobId, {
                pages_done: index + 1,
                progress: Math.round(((index + 1) / pages.length) * 100)
            });
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
                const pages = await source.getPages({ id: row.manga_id, title: row.manga_title }, { id: row.chapter_id, title: row.chapter_title });
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
        throw new Error(`Failed to download page "${url}": ${String((lastError as Error)?.message || lastError)}`);
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
