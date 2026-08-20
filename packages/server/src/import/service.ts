/**
 * Import service: server-side, persistent, resumable pipeline
 *   scan -> match (parallel, throttled) -> confirm -> sync chapters.
 * All state lives in SQLite so closing the dashboard (or restarting the
 * server) never loses progress.
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChapterInfo, SourceAdapter, SourceRegistry } from '@tanko/core';
import type { MigrationSuggestion } from '@tanko/shared';
import type { Database } from '../db.js';
import { chapterAllowed, sourceUsable } from '../languages.js';
import type { LibraryStore } from '../library/store.js';
import { assertValidDirectory, parseChapterNumber, scanLibrary } from './scanner.js';
import { confidenceFor, type MatchConfidence, stripTags, titleSimilarity } from './similarity.js';

export type JobStatus = 'scanning' | 'matching' | 'ready' | 'syncing' | 'done' | 'error';
export type AutoConfirmMode = 'auto' | 'all' | 'none';

export interface ImportOptions {
    /** 'auto': confirm high-confidence matches only; 'all': also review-tier; 'none': wait for the user. */
    autoConfirm?: AutoConfirmMode;
    /** auto-download future new chapters on imported entries (default false). */
    autoDownload?: boolean;
    /** parallel search workers (default: MATCH_CONCURRENCY). */
    concurrency?: number;
    /** restrict matching to these source ids (default: all usable). */
    sourceIds?: string[];
}

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

/** Dashboard-facing shape of status(): latest job, counters and per-series details. */
export interface JobStatusDto {
    job: {
        id: number;
        root: string;
        status: JobStatus;
        options: ImportOptions;
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
    series: Array<{
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
        candidates: MatchCandidate[];
        matchMode?: 'number' | 'ordinal';
        matched?: number;
        localChapters?: number;
        sourceChapters?: number;
        entryId?: number;
        error?: string;
    }>;
}

interface JobRow {
    id: number;
    root: string;
    status: JobStatus;
    options: string;
    error: string | null;
    created_at: string;
    updated_at: string;
}

interface SeriesRow {
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

const MATCH_CONCURRENCY = 4;

/** Cap on sources queried per series (exact match stops earlier); explicit sourceIds bypass it. */
const MAX_MATCH_SOURCES = 12;

export class ImportService {
    private cancelRequested = new Set<number>();
    private running = new Set<number>();
    private readonly sql: DatabaseSync;

    constructor(
        private readonly opts: {
            db: Database;
            registry: SourceRegistry;
            store: LibraryStore;
            listSources: () => Promise<SourceInfo[]>;
            getPreferredLanguages: () => string[];
        }
    ) {
        this.sql = this.opts.db.db;
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

    // ------------------------------------------------------------------
    // job lifecycle
    // ------------------------------------------------------------------

    /** Create a job and run the pipeline in the background. */
    async start(root: string, options: ImportOptions = {}): Promise<{ jobId: number }> {
        const resolved = assertValidDirectory(root);
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
        void this._run(jobId).catch(error => this._failJob(jobId, error));
        return { jobId };
    }

    /** Resume an interrupted/ready job: re-match pending series, sync confirmed ones. */
    async resume(jobId: number): Promise<void> {
        if (!this._resumableJob(jobId)) {
            return;
        }
        const pending = this.sql.prepare(`SELECT COUNT(*) AS n FROM import_series WHERE job_id = ? AND status = 'pending'`).get(jobId) as unknown as {
            n: number;
        };
        this._setStatus(jobId, pending.n > 0 ? 'matching' : 'syncing');
        void this._run(jobId, true).catch(error => this._failJob(jobId, error));
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
        this._setStatus(jobId, 'syncing');
        void this._syncAll(jobId).catch(error => this._failJob(jobId, error));
    }

    /** Current job (latest) with counters and series. */
    status(): JobStatusDto | { job: null } {
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

    // ------------------------------------------------------------------
    // pipeline
    // ------------------------------------------------------------------

    private async _run(jobId: number, resume = false): Promise<void> {
        const job = this._job(jobId);
        if (!job) {
            return;
        }
        this.running.add(jobId);
        const options: ImportOptions = JSON.parse(job.options || '{}');
        try {
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
            await this._matchAll(jobId, options);
            if (this.cancelRequested.has(jobId)) {
                this._setStatus(jobId, 'ready');
                return;
            }
            const mode = options.autoConfirm ?? 'none';
            if (mode !== 'none') {
                this.confirm(jobId, mode);
                this._setStatus(jobId, 'syncing');
                await this._syncAll(jobId);
            } else {
                this._setStatus(jobId, 'ready');
            }
        } finally {
            this.running.delete(jobId);
            this.cancelRequested.delete(jobId);
        }
    }

    /** Match every pending series against usable sources (bounded concurrency). */
    private async _matchAll(jobId: number, options: ImportOptions): Promise<void> {
        const preferred = this.opts.getPreferredLanguages();
        let sources = await this.opts.listSources();
        sources = sources.filter(
            source => !source.hidden && (options.sourceIds ? options.sourceIds.includes(source.id) : true) && sourceUsable(source.tags, preferred)
        );
        // healthy sources first, native before legacy (fast endpoints), then
        // multi-lingual catalogs (MangaDex…) before single-language legacy ones
        const multilingual = (source: SourceInfo) => source.tags.some(tag => tag.toLowerCase() === 'multi-lingual');
        const healthRank = (source: SourceInfo) => (source.health === 'ok' ? -1 : 1);
        const kindRank = (source: SourceInfo) => (source.kind === 'native' ? -1 : 1);
        sources.sort(
            (a, b) =>
                healthRank(a) - healthRank(b) ||
                kindRank(a) - kindRank(b) ||
                Number(multilingual(b)) - Number(multilingual(a)) ||
                a.label.localeCompare(b.label)
        );
        // without an explicit list, avoid catalog-scanning hundreds of untested legacy sources
        if (!options.sourceIds) {
            sources = sources.slice(0, MAX_MATCH_SOURCES);
        }
        if (sources.length === 0) {
            throw new Error('Aucune source utilisable (langue/santé) pour le matching');
        }

        const pending = () =>
            this.sql.prepare(`SELECT * FROM import_series WHERE job_id = ? AND status = 'pending' ORDER BY name LIMIT 1`).get(jobId) as unknown as
                | SeriesRow
                | undefined;

        const concurrency = Math.max(1, options.concurrency ?? MATCH_CONCURRENCY);
        const worker = async () => {
            for (;;) {
                if (this.cancelRequested.has(jobId)) {
                    return;
                }
                const series = pending();
                if (!series) {
                    return;
                }
                // claim it so another worker does not take the same row
                this.sql
                    .prepare(`UPDATE import_series SET status = 'matching', updated_at = ? WHERE job_id = ? AND path = ? AND status = 'pending'`)
                    .run(this.now(), jobId, series.path);
                try {
                    await this._matchSeries(jobId, series, sources);
                } catch (error) {
                    console.warn(`[import] match failed for "${series.name}":`, (error as Error).message);
                    this.sql
                        .prepare(
                            `UPDATE import_series SET status = 'matched', confidence = 'none', error = ?, updated_at = ?
                         WHERE job_id = ? AND path = ?`
                        )
                        .run((error as Error).message, this.now(), jobId, series.path);
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
    }

    private async _matchSeries(jobId: number, series: SeriesRow, sources: SourceInfo[]): Promise<void> {
        const needle = series.needle || series.name;
        // try the raw name, then tag-stripped variants ("Dungeon Reset [Official]" -> "Dungeon Reset")
        const queries = [...new Set([needle, stripTags(needle).trim(), stripTags(series.name).trim()].filter(query => query.length > 2))];
        const candidates: MatchCandidate[] = [];
        let best: MatchCandidate | null = null;

        for (const source of sources) {
            if (this.cancelRequested.has(jobId)) {
                return;
            }
            try {
                const adapter = await this.opts.registry.get(source.id);
                if (!adapter) {
                    continue;
                }
                const results: Array<{ id: string; title: string }> = [];
                for (const query of queries) {
                    results.push(...(await adapter.searchMangas(query)));
                    if (results.length > 0) {
                        break; // a looser query is only a fallback
                    }
                }
                for (const manga of results.slice(0, 10)) {
                    const score = titleSimilarity(series.name, manga.title);
                    const candidate: MatchCandidate = {
                        sourceId: source.id,
                        sourceLabel: source.label,
                        mangaId: manga.id,
                        mangaTitle: manga.title,
                        score
                    };
                    candidates.push(candidate);
                    if (!best || score > best.score) {
                        best = candidate;
                    }
                }
            } catch {
                /* a broken source never blocks the others */
            }
            if (best && best.score >= 1) {
                break; // exact match: no need to query the remaining sources
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        const confidence = confidenceFor(best?.score);
        const chosen = confidence === 'none' ? null : best;
        this.sql
            .prepare(
                `UPDATE import_series SET status = 'matched', confidence = ?, score = ?,
                    source_id = ?, source_label = ?, manga_id = ?, manga_title = ?,
                    candidates = ?, updated_at = ?
             WHERE job_id = ? AND path = ?`
            )
            .run(
                confidence,
                best?.score ?? null,
                chosen?.sourceId ?? null,
                chosen?.sourceLabel ?? null,
                chosen?.mangaId ?? null,
                chosen?.mangaTitle ?? null,
                JSON.stringify(candidates.slice(0, 8)),
                this.now(),
                jobId,
                series.path
            );
    }

    /** Sync every confirmed series: add to the library, mark local chapters as downloaded. */
    private async _syncAll(jobId: number): Promise<void> {
        const options: ImportOptions = JSON.parse(this._job(jobId)?.options || '{}');
        const preferred = this.opts.getPreferredLanguages();
        const rows = this.sql
            .prepare(`SELECT * FROM import_series WHERE job_id = ? AND confirmed = 1 AND status != 'synced' ORDER BY name`)
            .all(jobId) as unknown as SeriesRow[];

        for (const series of rows) {
            if (this.cancelRequested.has(jobId)) {
                this._setStatus(jobId, 'ready');
                return;
            }
            try {
                const result = await this._syncSeries(series, options.autoDownload === true, preferred);
                this.sql
                    .prepare(
                        `UPDATE import_series SET status = 'synced', matched = ?, local_chapters = ?, source_chapters = ?,
                            match_mode = ?, entry_id = ?, error = NULL, updated_at = ?
                     WHERE job_id = ? AND path = ?`
                    )
                    .run(result.matched, result.localChapters, result.sourceChapters, result.mode, result.entryId, this.now(), jobId, series.path);
            } catch (error) {
                console.warn(`[import] sync failed for "${series.name}":`, (error as Error).message);
                this.sql
                    .prepare(`UPDATE import_series SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND path = ?`)
                    .run((error as Error).message, this.now(), jobId, series.path);
            }
        }
        this._setStatus(jobId, 'done');
    }

    /**
     * One series: local files <-> source chapters, matched by chapter number.
     * When numbers barely match but both sides agree on the count (re-numbered
     * seasons), _pairChapters falls back to positional alignment — flagged as
     * 'ordinal'.
     */
    private async _syncSeries(
        series: SeriesRow,
        autoDownload: boolean,
        preferred: string[]
    ): Promise<{
        matched: number;
        localChapters: number;
        sourceChapters: number;
        mode: 'number' | 'ordinal';
        entryId: number;
    }> {
        const { source_id: sourceId, manga_id: mangaId, manga_title: mangaTitle } = series;
        if (!sourceId || !mangaId || !mangaTitle) {
            throw new Error(`Series "${series.name}" has no confirmed source match`);
        }
        const source = await this.opts.registry.get(sourceId);
        if (!source) {
            throw new Error(`Source "${sourceId}" introuvable`);
        }
        const local = this._localChapters(series);
        // fetch the source chapters BEFORE creating the library entry: a series
        // whose source is dead/emptied must not leave a ghost entry behind
        const { chapters, byNumber: sourceByNumber } = await this._sourceChapters({ id: mangaId, title: mangaTitle }, source, preferred);
        const { entry } = await this.opts.store.addEntry({
            sourceId,
            mangaId,
            title: mangaTitle,
            autoDownload
        });
        const { pairs, mode } = this._pairChapters(local.byNumber, sourceByNumber);

        for (const pair of pairs) {
            this.opts.store.markChapter(entry.id, pair.chapterId, 'downloaded', pair.localPath, 'import');
        }
        return { matched: pairs.length, localChapters: local.total, sourceChapters: chapters.length, mode, entryId: entry.id };
    }

    /** Local chapters of a series folder: number -> file path (first occurrence wins), plus total count. */
    private _localChapters(series: SeriesRow): { byNumber: Map<number, string>; total: number } {
        const scan = scanLibrary(series.path);
        const ownSeries = scan.series.find(item => item.path === path.resolve(series.path)) || scan.series[0];
        const byNumber = new Map<number, string>();
        let total = 0;
        for (const chapter of ownSeries?.chapters || []) {
            total++;
            if (chapter.number !== null && !byNumber.has(chapter.number)) {
                byNumber.set(chapter.number, path.join(series.path, chapter.file));
            }
        }
        return { byNumber, total };
    }

    /** Source chapters usable for this user (language filter), keyed by parsed chapter number (first wins). */
    private async _sourceChapters(
        manga: { id: string; title: string },
        source: SourceAdapter,
        preferred: string[]
    ): Promise<{
        chapters: ChapterInfo[];
        byNumber: Map<number, ChapterInfo>;
    }> {
        const allChapters = await source.getChapters(manga);
        const chapters = allChapters.filter(chapter => chapterAllowed(chapter.language, preferred));
        const byNumber = new Map<number, ChapterInfo>();
        for (const chapter of chapters) {
            const number = parseChapterNumber(chapter.title);
            if (number !== null && !byNumber.has(number)) {
                byNumber.set(number, chapter);
            }
        }
        return { chapters, byNumber };
    }

    /** Pair source chapters with local files by number; ordinal fallback for re-numbered seasons. */
    private _pairChapters(
        localByNumber: Map<number, string>,
        sourceByNumber: Map<number, { id: string }>
    ): {
        pairs: Array<{ chapterId: string; localPath: string }>;
        mode: 'number' | 'ordinal';
    } {
        let pairs: Array<{ chapterId: string; localPath: string }> = [];
        for (const [number, chapter] of sourceByNumber) {
            const localPath = localByNumber.get(number);
            if (localPath) {
                pairs.push({ chapterId: chapter.id, localPath });
            }
        }

        let mode: 'number' | 'ordinal' = 'number';
        const minCount = Math.min(localByNumber.size, sourceByNumber.size);
        const bothNumbered = localByNumber.size > 0 && sourceByNumber.size > 0;
        const similarCounts = Math.abs(localByNumber.size - sourceByNumber.size) <= Math.max(3, localByNumber.size * 0.1);
        if (bothNumbered && similarCounts && minCount > 0 && pairs.length / minCount < 0.5) {
            // re-numbering: align both sides by sorted chapter number
            const localSorted = [...localByNumber.entries()].sort((a, b) => a[0] - b[0]);
            const sourceSorted = [...sourceByNumber.entries()].sort((a, b) => a[0] - b[0]);
            const ordinalPairs: typeof pairs = [];
            for (let i = 0; i < Math.min(localSorted.length, sourceSorted.length); i++) {
                ordinalPairs.push({ chapterId: sourceSorted[i][1].id, localPath: localSorted[i][1] });
            }
            if (ordinalPairs.length > pairs.length) {
                pairs = ordinalPairs;
                mode = 'ordinal';
            }
        }
        return { pairs, mode };
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

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
        console.error(`[import] job ${jobId} failed:`, (error as Error).message);
        this.sql.prepare('UPDATE import_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('error', (error as Error).message, this.now(), jobId);
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
