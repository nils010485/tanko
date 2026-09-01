/**
 * Import service: server-side, persistent, resumable pipeline
 *   scan -> match (parallel, throttled) -> confirm -> sync chapters.
 * All state lives in SQLite so closing the dashboard (or restarting the
 * server) never loses progress.
 *
 * The service is a facade over focused modules: matcher.ts (source
 * matching) and syncer.ts (chapter sync). Job lifecycle and state live here.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SourceRegistry } from '@tanko/core';
import type { AutoConfirmMode, ImportJobPhase, ImportJobStatusDto, ImportOptionsDto, MigrationSuggestion } from '@tanko/shared';
import type { JobHandle, JobRunner } from '../activity/jobs.js';
import type { Database } from '../db.js';
import type { LibraryStore } from '../library/store.js';
import type { EventBus } from '../ws.js';
import { type MatcherContext, matchAll } from './matcher.js';
import { assertValidDirectory, scanLibrary } from './scanner.js';
import type { MatchConfidence } from './similarity.js';
import { type SyncerContext, syncAll } from './syncer.js';

/** Pipeline phase of the current job (legacy server-side name). */
export type JobStatus = ImportJobPhase;
export type { AutoConfirmMode };
export type ImportOptions = ImportOptionsDto;
/** Thrown when an import would double-crawl the sources (the Activity registry allows a single crawl job). */
export const CRAWL_BUSY_ERROR = 'Un scan de sources est déjà en cours (re-match, meilleures sources ou import) — attendez sa fin';

export interface SourceInfo {
    id: string;
    label: string;
    tags: string[];
    kind: 'legacy' | 'native';
    health?: string;
    hidden?: boolean;
}

/** Match candidate for a local series (same shape as the dashboard's MigrationSuggestion DTO). */
export type MatchCandidate = MigrationSuggestion;

export interface JobRow {
    id: number;
    root: string;
    status: JobStatus;
    options: string;
    error: string | null;
    created_at: string;
    updated_at: string;
}

export interface SeriesRow {
    job_id: number;
    path: string;
    name: string;
    needle: string | null;
    chapter_count: number;
    status: string;
    confidence: MatchConfidence | null;
    score: number | null;
    confirmed: number;
    source_id: string | null;
    source_label: string | null;
    manga_id: string | null;
    manga_title: string | null;
    candidates: string | null;
    match_mode: 'number' | 'ordinal' | null;
    matched: number | null;
    local_chapters: number | null;
    source_chapters: number | null;
    entry_id: number | null;
    error: string | null;
    updated_at: string;
}

export class ImportService {
    private cancelRequested = new Set<number>();
    private running = new Set<number>();
    /** Activity job handles of the running imports, keyed by import job id. */
    private readonly activeHandles = new Map<number, JobHandle>();
    private readonly sql: DatabaseSync;
    private readonly matcher: MatcherContext;
    private readonly syncer: SyncerContext;

    constructor(
        private readonly opts: {
            db: Database;
            registry: SourceRegistry;
            store: LibraryStore;
            listSources: () => Promise<SourceInfo[]>;
            getPreferredLanguages: () => string[];
            /** Activity feed + job registry: import runs appear there with progress and cancel. */
            events: EventBus;
            jobs: JobRunner;
        }
    ) {
        this.sql = this.opts.db.db;
        this.matcher = {
            sql: this.sql,
            registry: this.opts.registry,
            cancelRequested: this.cancelRequested,
            getPreferredLanguages: this.opts.getPreferredLanguages,
            listSources: this.opts.listSources,
            onProgress: jobId => this.updateProgress(jobId, 'match')
        };
        this.syncer = {
            sql: this.sql,
            registry: this.opts.registry,
            store: this.opts.store,
            cancelRequested: this.cancelRequested,
            getPreferredLanguages: this.opts.getPreferredLanguages,
            getJob: jobId => this._job(jobId),
            setStatus: (jobId, status) => this._setStatus(jobId, status),
            onProgress: jobId => this.updateProgress(jobId, 'sync')
        };
        this._migrate();
        // a server restart interrupts whatever was in flight; it can be resumed explicitly
        this.sql
            .prepare(
                `UPDATE import_jobs SET status = 'ready', updated_at = ?
             WHERE status IN ('scanning', 'matching', 'syncing')`
            )
            .run(this.now());
        // a crash mid-match leaves rows in 'matching' — make them eligible again
        this.sql.exec(`UPDATE import_series SET status = 'pending' WHERE status = 'matching'`);
    }

    /** Create a job and run the pipeline in the background. */
    async start(root: string, options: ImportOptions = {}): Promise<{ jobId: number }> {
        const resolved = assertValidDirectory(root);
        if (this.opts.jobs.crawlBusy()) {
            throw new Error(CRAWL_BUSY_ERROR);
        }
        const now = this.now();
        // one active job at a time: a previous unfinished job is superseded
        this.sql
            .prepare(
                `UPDATE import_jobs SET status = 'error', error = 'remplacé par un nouvel import', updated_at = ?
             WHERE status IN ('scanning', 'matching', 'syncing', 'ready')`
            )
            .run(now);
        const result = this.sql
            .prepare('INSERT INTO import_jobs (root, status, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(resolved, 'scanning', JSON.stringify(options), now, now);
        const jobId = Number(result.lastInsertRowid);
        const handle = this.startActivityJob(jobId);
        void this._run(jobId, false, handle).catch(error => this.failRun(jobId, error));
        return { jobId };
    }

    /** Resume an interrupted/ready job: re-match pending series, sync confirmed ones. */
    async resume(jobId: number): Promise<void> {
        if (!this._resumableJob(jobId)) {
            return;
        }
        const handle = this.startActivityJob(jobId);
        const pending = this.sql.prepare(`SELECT COUNT(*) AS n FROM import_series WHERE job_id = ? AND status = 'pending'`).get(jobId) as unknown as {
            n: number;
        };
        this._setStatus(jobId, pending.n > 0 ? 'matching' : 'syncing');
        void this._run(jobId, true, handle).catch(error => this.failRun(jobId, error));
    }

    /** Stop background work after the current series; confirmed choices are kept. */
    cancel(jobId: number): void {
        this.cancelRequested.add(jobId);
    }

    /** Manually confirm (or correct) the match for one series. */
    choose(jobId: number, seriesPath: string, candidate: { sourceId: string; sourceLabel: string; mangaId: string; mangaTitle: string }): void {
        this.sql
            .prepare(
                `UPDATE import_series SET source_id = ?, source_label = ?, manga_id = ?, manga_title = ?,
                    confirmed = 1, status = 'matched', confidence = COALESCE(confidence, 'review'), updated_at = ?
             WHERE job_id = ? AND path = ?`
            )
            .run(candidate.sourceId, candidate.sourceLabel, candidate.mangaId, candidate.mangaTitle, this.now(), jobId, seriesPath);
    }

    /** Bulk-confirm everything that has a candidate ('auto' = high-confidence only, 'all' = review too). */
    confirm(jobId: number, mode: AutoConfirmMode): number {
        const tiers = mode === 'all' ? "('auto', 'review')" : "('auto')";
        const result = this.sql
            .prepare(
                `UPDATE import_series SET confirmed = 1, updated_at = ?
             WHERE job_id = ? AND status = 'matched' AND manga_id IS NOT NULL AND confidence IN ${tiers}`
            )
            .run(this.now(), jobId);
        return Number(result.changes);
    }

    /** Sync all confirmed series into the library (runs in background). */
    async sync(jobId: number): Promise<void> {
        if (!this._resumableJob(jobId)) {
            return;
        }
        const handle = this.startActivityJob(jobId);
        this.running.add(jobId);
        this._setStatus(jobId, 'syncing');
        this.updateProgress(jobId, 'sync');
        void this.runPhases(jobId, handle, () => syncAll(this.syncer, jobId));
    }

    /** Current job (latest) with counters and series. */
    status(): ImportJobStatusDto | { job: null } {
        const job = this.sql.prepare('SELECT * FROM import_jobs ORDER BY id DESC LIMIT 1').get() as unknown as JobRow | undefined;
        if (!job) {
            return { job: null };
        }
        const series = this.sql.prepare('SELECT * FROM import_series WHERE job_id = ? ORDER BY name COLLATE NOCASE ASC').all(job.id) as unknown as SeriesRow[];
        const counters = {
            total: series.length,
            matched: 0,
            auto: 0,
            review: 0,
            none: 0,
            confirmed: 0,
            synced: 0,
            failed: 0
        };
        for (const s of series) {
            if (s.status !== 'pending') {
                counters.matched++;
                if (s.confidence === 'none') {
                    counters.none++;
                }
            }
            if (s.confidence === 'auto') {
                counters.auto++;
            }
            if (s.confidence === 'review') {
                counters.review++;
            }
            if (s.confirmed === 1) {
                counters.confirmed++;
            }
            if (s.status === 'synced') {
                counters.synced++;
            }
            if (s.status === 'failed') {
                counters.failed++;
            }
        }
        return {
            job: {
                id: job.id,
                root: job.root,
                status: job.status,
                options: JSON.parse(job.options || '{}'),
                error: job.error || undefined,
                createdAt: job.created_at,
                updatedAt: job.updated_at
            },
            counters,
            series: series.map(row => ({
                path: row.path,
                name: row.name,
                chapterCount: row.chapter_count,
                status: row.status,
                confidence: row.confidence || undefined,
                score: row.score ?? undefined,
                confirmed: row.confirmed === 1,
                sourceId: row.source_id || undefined,
                sourceLabel: row.source_label || undefined,
                mangaId: row.manga_id || undefined,
                mangaTitle: row.manga_title || undefined,
                candidates: row.candidates ? JSON.parse(row.candidates) : [],
                matchMode: row.match_mode || undefined,
                matched: row.matched ?? undefined,
                localChapters: row.local_chapters ?? undefined,
                sourceChapters: row.source_chapters ?? undefined,
                entryId: row.entry_id ?? undefined,
                error: row.error || undefined
            }))
        };
    }

    private async _run(jobId: number, resume = false, handle?: JobHandle): Promise<void> {
        const job = this._job(jobId);
        if (!job) {
            return;
        }
        this.running.add(jobId);
        await this.runPhases(jobId, handle, async () => {
            const options: ImportOptions = JSON.parse(job.options || '{}');
            this.log(`démarré : ${job.root}`, 'import.started', { root: job.root });
            if (!resume) {
                const scan = scanLibrary(job.root);
                if (scan.series.length === 0) {
                    // e.g. library mount not ready at boot: fail so the next start retries
                    throw new Error(`Aucune série détectée dans ${job.root} (montage absent ou dossier vide ?)`);
                }
                const now = this.now();
                const insert = this.sql.prepare(
                    `INSERT INTO import_series (job_id, path, name, needle, chapter_count, status, updated_at)
                     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
                );
                for (const series of scan.series) {
                    insert.run(jobId, series.path, series.name, series.metaName || null, series.chapterCount, now);
                }
                this._setStatus(jobId, 'matching');
            }
            this.updateProgress(jobId, 'match');
            const total = this.countSeries(jobId);
            this.log(`matching : ${total} série(s)`, 'import.matching', { total });
            await matchAll(this.matcher, jobId, options);
            if (this.cancelRequested.has(jobId)) {
                this._setStatus(jobId, 'ready');
                return;
            }
            const mode = options.autoConfirm ?? 'none';
            if (mode !== 'none') {
                const confirmed = this.confirm(jobId, mode);
                this._setStatus(jobId, 'syncing');
                this.updateProgress(jobId, 'sync');
                this.log(`synchronisation : ${confirmed} série(s) confirmée(s)`, 'import.syncing', { total: confirmed });
                await syncAll(this.syncer, jobId);
            } else {
                this._setStatus(jobId, 'ready');
            }
        });
    }

    /** Reserve the Activity job slot for an import run (progress + cancel in
     *  the dashboard). Throws when another crawl job already holds it. */
    private startActivityJob(jobId: number): JobHandle {
        const handle = this.opts.jobs.begin('import.run', 'Import de bibliothèque', this.countSeries(jobId), {
            crawl: true,
            onCancel: () => this.cancel(jobId)
        });
        if (!handle) {
            throw new Error(CRAWL_BUSY_ERROR);
        }
        this.activeHandles.set(jobId, handle);
        return handle;
    }

    /** Finish and forget the Activity job of an import run (idempotent). */
    private releaseActivityJob(jobId: number, cancelled: boolean): void {
        this.activeHandles.get(jobId)?.finish(cancelled);
        this.activeHandles.delete(jobId);
    }

    /** Safety net for the fire-and-forget _run promise: record the failure and release the Activity job. */
    private failRun(jobId: number, error: unknown): void {
        this._failJob(jobId, error);
        this.releaseActivityJob(jobId, false);
    }

    /** Drive one background run: recap log on success, failure log through
     *  _failJob, cancel flag and Activity job release on every exit path. */
    private async runPhases(jobId: number, handle: JobHandle | undefined, phases: () => Promise<void>): Promise<void> {
        let failed = false;
        try {
            await phases();
            if (!this.cancelRequested.has(jobId)) {
                this.logFinished(jobId);
            }
        } catch (error) {
            failed = true;
            this._failJob(jobId, error);
        } finally {
            this.running.delete(jobId);
            // a failed run is a failure, not a cancellation — _failJob already logged the terminal line
            const cancelled = !failed && this.cancelRequested.has(jobId);
            this.cancelRequested.delete(jobId);
            if (cancelled) {
                const { done, total } = handle?.job ?? { done: 0, total: 0 };
                this.log(`annulé après ${done}/${total} série(s)`, 'import.cancelled', { done, total });
            }
            this.releaseActivityJob(jobId, cancelled);
        }
    }

    private countSeries(jobId: number): number {
        const row = this.sql.prepare('SELECT COUNT(*) AS n FROM import_series WHERE job_id = ?').get(jobId) as unknown as { n: number };
        return row.n;
    }

    /** Push the settled-series counts of the current phase into the Activity job. */
    private updateProgress(jobId: number, mode: 'match' | 'sync'): void {
        const handle = this.activeHandles.get(jobId);
        if (!handle) {
            return;
        }
        const settled = mode === 'match' ? `status NOT IN ('pending', 'matching')` : `status IN ('synced', 'failed')`;
        const row = this.sql
            .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN ${settled} THEN 1 ELSE 0 END) AS done,
                        SUM(CASE WHEN status = 'synced' THEN 1 ELSE 0 END) AS hits
                 FROM import_series WHERE job_id = ?`
            )
            .get(jobId) as unknown as { total: number; done: number | null; hits: number | null };
        handle.update({ total: row.total, done: Number(row.done), hits: Number(row.hits) });
    }

    /** Phase line in the Activity feed (category 'scan'); the dashboard translates `activity.<code>`. */
    private log(message: string, code: string, params: Record<string, string | number>): void {
        this.opts.events.publishLog({ level: 'info', category: 'scan', code, params, message: `[import] ${message}` });
    }

    private logFinished(jobId: number): void {
        const row = this.sql
            .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status NOT IN ('pending', 'matching') THEN 1 ELSE 0 END) AS matched,
                        SUM(CASE WHEN status = 'synced' THEN 1 ELSE 0 END) AS synced
                 FROM import_series WHERE job_id = ?`
            )
            .get(jobId) as unknown as { total: number; matched: number | null; synced: number | null };
        this.log(`terminé : ${Number(row.matched)}/${row.total} série(s) appariée(s), ${Number(row.synced)} synchronisée(s)`, 'import.finished', {
            total: row.total,
            matched: Number(row.matched),
            synced: Number(row.synced)
        });
    }
    private now(): string {
        return new Date().toISOString();
    }

    private _job(jobId: number): JobRow | undefined {
        return this.sql.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined;
    }

    /** Shared guard for resume/sync: throws on unknown job, returns null when already running. */
    private _resumableJob(jobId: number): JobRow | null {
        const job = this._job(jobId);
        if (!job) {
            throw new Error(`Job ${jobId} introuvable`);
        }
        if (this.running.has(jobId)) {
            return null;
        }
        return job;
    }

    private _setStatus(jobId: number, status: JobStatus): void {
        this.sql.prepare('UPDATE import_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), jobId);
    }

    private _failJob(jobId: number, error: unknown): void {
        const message = (error as Error).message;
        console.error(`[import] job ${jobId} failed:`, message);
        this.opts.events.publishLog({
            level: 'error',
            category: 'scan',
            code: 'import.failed',
            params: { error: message },
            message: `[import] job ${jobId} échoué : ${message}`
        });
        this.sql.prepare('UPDATE import_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('error', message, this.now(), jobId);
    }

    private _migrate(): void {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS import_jobs (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                root       TEXT NOT NULL,
                status     TEXT NOT NULL,
                options    TEXT NOT NULL DEFAULT '{}',
                error      TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS import_series (
                job_id          INTEGER NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
                path            TEXT NOT NULL,
                name            TEXT NOT NULL,
                needle          TEXT,
                chapter_count   INTEGER NOT NULL DEFAULT 0,
                status          TEXT NOT NULL DEFAULT 'pending',
                confidence      TEXT,
                score           REAL,
                confirmed       INTEGER NOT NULL DEFAULT 0,
                source_id       TEXT,
                source_label    TEXT,
                manga_id        TEXT,
                manga_title     TEXT,
                candidates      TEXT,
                match_mode      TEXT,
                matched         INTEGER,
                local_chapters  INTEGER,
                source_chapters INTEGER,
                entry_id        INTEGER,
                error           TEXT,
                updated_at      TEXT NOT NULL,
                PRIMARY KEY (job_id, path)
            );
        `);
    }
}
