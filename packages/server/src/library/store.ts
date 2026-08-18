/**
 * Library store: tracked series + their known chapters.
 * The scheduler diffs the source's chapter list against this store to find
 * new chapters; the download queue reports back through markChapter().
 * Every chapter status/path change is journaled in chapter_history (rollback),
 * and source migrations keep a full snapshot in entry_snapshots (undo).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import type { SourceAdapter, SourceRegistry } from '@tanko/core';
import type { Database } from '../db.js';
import type { DownloadQueue, QueueSettings } from '../downloader/queue.js';
import { chapterPaths, outputExists } from '../downloader/paths.js';
import { chapterAllowed } from '../languages.js';
import { parseChapterNumber } from '../import/scanner.js';

/** Shared INSERT statements for chapter rows (6-column snapshot, 6-column forced 'new', full 8-column). */
const SQL_INSERT_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, ?, ?)`;
const SQL_INSERT_NEW_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, 'new', ?)`;
const SQL_INSERT_CHAPTER_FULL = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, path, discovered_at, downloaded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

interface EntryRow {
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
    hidden: number;
    last_checked_at: string | null;
    added_at: string;
}

export interface ChapterRow {
    id: number;
    entry_id: number;
    chapter_id: string;
    title: string;
    language: string | null;
    status: 'new' | 'queued' | 'downloading' | 'downloaded' | 'failed';
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
}

export class LibraryStore {

    constructor(private readonly opts: {
        db: Database;
        registry: SourceRegistry;
        queueSettings: QueueSettings;
        /** Preferred chapter languages (ISO codes); empty = keep everything. */
        getPreferredLanguages?: () => string[];
    }) {
        this._migrate();
    }

    // ------------------------------------------------------------------
    // entries
    // ------------------------------------------------------------------

    /**
     * Add a series to the library. The current chapter list is snapshotted so
     * that only chapters published *after* this point are treated as new.
     */
    async addEntry(entry: {
        sourceId: string;
        mangaId: string;
        title: string;
        url?: string;
        thumbnail?: string;
        autoDownload?: boolean;
    }): Promise<{ entry: LibraryEntryDto; snapshot: number }> {
        const source = await this.opts.registry.get(entry.sourceId);
        if (!source) {
            throw new Error(`Source "${entry.sourceId}" not found`);
        }
        const now = new Date().toISOString();
        const result = this._get<{ id: number }>(
            `INSERT INTO library (source_id, source_label, manga_id, title, url, thumbnail, auto_download, last_checked_at, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, manga_id) DO UPDATE SET title = excluded.title, url = excluded.url,
                 thumbnail = COALESCE(excluded.thumbnail, library.thumbnail)
             RETURNING id`,
            entry.sourceId, source.label, entry.mangaId, entry.title, entry.url || null, entry.thumbnail || null, entry.autoDownload === false ? 0 : 1, now, now
        );

        // snapshot current chapters
        let snapshot = 0;
        try {
            const chapters = await source.getChapters({ id: entry.mangaId, title: entry.title });
            const insert = this.opts.db.db.prepare(SQL_INSERT_CHAPTER);
            const preferred = this.opts.getPreferredLanguages?.() || [];
            for (const chapter of chapters) {
                if (!chapterAllowed(chapter.language, preferred)) {
                    continue;
                }
                const status = this._isDownloaded(source.label, entry.title, chapter.title) ? 'downloaded' : 'new';
                insert.run(result!.id, chapter.id, chapter.title, chapter.language || null, status, now);
                snapshot++;
            }
        } catch (error) {
            console.warn(`[library] initial snapshot failed for "${entry.title}":`, (error as Error).message);
        }
        return { entry: this.getEntry(result!.id)!, snapshot };
    }

    /** Remove the entry from Tanko; with `disk`, also delete the series folder. */
    removeEntry(entryId: number, options: { disk?: boolean } = {}): { ok: boolean; deletedPath?: string } {
        const row = this._getEntryRow(entryId);
        const result = this.opts.db.db.prepare('DELETE FROM library WHERE id = ?').run(entryId);
        if (Number(result.changes) === 0) {
            return { ok: false };
        }
        if (options.disk && row) {
            const directory = this.seriesDirectory(entryId, row);
            // force:true makes rmSync silent on a missing path — check first so
            // deletedPath only reports a folder that was actually removed
            if (directory && fs.existsSync(directory)) {
                try {
                    fs.rmSync(directory, { recursive: true, force: true });
                    return { ok: true, deletedPath: directory };
                } catch {
                    // entry is gone even if the folder could not be removed
                }
            }
        }
        return { ok: true };
    }

    /** Directory holding the entry's files: deepest common ancestor of the
     *  downloaded chapter paths, falling back to the configured layout. */
    seriesDirectory(entryId: number, row?: EntryRow): string | null {
        const entry = row ?? this._getEntryRow(entryId);
        if (!entry) {
            return null;
        }
        const paths = this._all<{ path: string }>(
            'SELECT path FROM library_chapters WHERE entry_id = ? AND path IS NOT NULL AND length(path) > 0',
            entryId
        ).map(item => item.path.split(/[\\/]/));
        if (paths.length > 0) {
            // most frequent parent directory: robust to a few stray paths
            // (e.g. chapters marked before a data-directory change)
            const counts = new Map<string, number>();
            for (const parts of paths) {
                const directory = parts.slice(0, -1).join(path.sep);
                counts.set(directory, (counts.get(directory) ?? 0) + 1);
            }
            let best: string | null = null;
            let bestCount = 0;
            for (const [directory, count] of counts) {
                if (count > bestCount) {
                    best = directory;
                    bestCount = count;
                }
            }
            if (best && bestCount > 0 && best !== path.sep && best !== '.') {
                return best;
            }
        }
        const settings = this.opts.queueSettings;
        const target = chapterPaths(settings.dataDirectory, entry.source_label, entry.title, 'Chapter 0', settings.directoryLayout).cbzFile;
        return path.dirname(target);
    }

    getEntry(entryId: number): LibraryEntryDto | undefined {
        const row = this._getEntryRow(entryId);
        return row ? this._entryToDto(row) : undefined;
    }

    async listEntries(filter: 'visible' | 'hidden' | 'all' = 'visible'): Promise<LibraryEntryDto[]> {
        const where = filter === 'visible' ? 'WHERE hidden = 0' : filter === 'hidden' ? 'WHERE hidden = 1' : '';
        const rows = this._all<EntryRow>(`SELECT * FROM library ${where} ORDER BY title COLLATE NOCASE ASC`);
        return Promise.all(rows.map(row => this._entryToDto(row)));
    }

    /** Hide (or restore) an entry without touching its files. */
    setHidden(entryId: number, hidden: boolean): boolean {
        const result = this.opts.db.db.prepare('UPDATE library SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, entryId);
        return Number(result.changes) > 0;
    }

    setAutoDownload(entryId: number, autoDownload: boolean): boolean {
        const result = this.opts.db.db.prepare('UPDATE library SET auto_download = ? WHERE id = ?').run(autoDownload ? 1 : 0, entryId);
        return Number(result.changes) > 0;
    }

    // ------------------------------------------------------------------
    // source health / failover
    // ------------------------------------------------------------------

    /** Consecutive download failures on an entry (reset by a success or a migration). */
    recordDownloadFailure(entryId: number): number {
        this.opts.db.db.prepare('UPDATE library SET download_failures = download_failures + 1 WHERE id = ?').run(entryId);
        return Number((this._get('SELECT download_failures AS n FROM library WHERE id = ?', entryId) as { n: number }).n);
    }

    resetDownloadFailures(entryId: number): void {
        this.opts.db.db.prepare('UPDATE library SET download_failures = 0 WHERE id = ?').run(entryId);
    }

    /** Entries whose downloads keep failing (candidates for a source failover). */
    listDownloadFailing(minimum: number): Array<{ id: number; sourceId: string; title: string; downloadFailures: number }> {
        return this._all<{ id: number; source_id: string; title: string; download_failures: number }>(
            'SELECT id, source_id, title, download_failures FROM library WHERE hidden = 0 AND download_failures >= ? ORDER BY download_failures DESC',
            minimum
        ).map(row => ({ id: row.id, sourceId: row.source_id, title: row.title, downloadFailures: Number(row.download_failures) }));
    }

    recordCheckFailure(entryId: number): number {
        this.opts.db.db.prepare('UPDATE library SET check_failures = check_failures + 1 WHERE id = ?').run(entryId);
        const row = this._get<{ n: number }>('SELECT check_failures AS n FROM library WHERE id = ?', entryId);
        return Number(row?.n || 0);
    }

    resetCheckFailures(entryId: number): void {
        this.opts.db.db.prepare('UPDATE library SET check_failures = 0 WHERE id = ?').run(entryId);
    }

    setMigrationSuggestion(entryId: number, suggestion: MigrationTarget | null): void {
        this.opts.db.db.prepare('UPDATE library SET migration_suggestion = ? WHERE id = ?')
            .run(suggestion ? JSON.stringify(suggestion) : null, entryId);
    }

    /**
     * Move an entry to another source: snapshot the current state, then rebuild
     * the chapter list from the new source. Downloaded chapters keep their
     * local file, matched by chapter number.
     */
    async migrateEntry(entryId: number, target: MigrationTarget): Promise<{ kept: number; total: number }> {
        const row = this._getEntryRow(entryId);
        if (!row) {
            throw new Error(`Library entry ${entryId} not found`);
        }
        const source = await this.opts.registry.get(target.sourceId);
        if (!source) {
            throw new Error(`Source "${target.sourceId}" introuvable`);
        }

        this._snapshotEntry(entryId, 'failover');
        const downloadedByNumber = this._downloadedByNumber(entryId);
        return this._rebuildChapters(entryId, target, source, downloadedByNumber);
    }

    /** Downloaded chapters of an entry keyed by chapter number (first occurrence wins). */
    private _downloadedByNumber(entryId: number): Map<number, ChapterRow> {
        const oldChapters = this._all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId);
        const downloadedByNumber = new Map<number, ChapterRow>();
        for (const chapter of oldChapters) {
            if (chapter.status !== 'downloaded' || !chapter.path) {
                continue;
            }
            const number = parseChapterNumber(chapter.title);
            if (number !== null && !downloadedByNumber.has(number)) {
                downloadedByNumber.set(number, chapter);
            }
        }
        return downloadedByNumber;
    }

    /** Replace the entry's chapter list from the new source, carrying downloaded files over. */
    private async _rebuildChapters(entryId: number, target: MigrationTarget, source: SourceAdapter, downloadedByNumber: Map<number, ChapterRow>): Promise<{ kept: number; total: number }> {
        const chapters = await source.getChapters({ id: target.mangaId, title: target.mangaTitle });
        const preferred = this.opts.getPreferredLanguages?.() || [];
        const now = new Date().toISOString();

        this.opts.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
        this.opts.db.db.prepare(
            `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                    migration_suggestion = NULL, check_failures = 0, last_checked_at = ? WHERE id = ?`
        ).run(target.sourceId, source.label, target.mangaId, target.mangaTitle, target.url || null, now, entryId);

        const insert = this.opts.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
        let kept = 0;
        let total = 0;
        for (const chapter of chapters) {
            if (!chapterAllowed(chapter.language, preferred)) {
                continue;
            }
            total++;
            const number = parseChapterNumber(chapter.title);
            const carried = number !== null ? downloadedByNumber.get(number) : undefined;
            if (carried) {
                insert.run(entryId, chapter.id, chapter.title, chapter.language || null, 'downloaded', carried.path, now, carried.downloaded_at);
                kept++;
            } else {
                const status = this._isDownloaded(source.label, target.mangaTitle, chapter.title) ? 'downloaded' : 'new';
                insert.run(entryId, chapter.id, chapter.title, chapter.language || null, status, null, now, null);
            }
        }
        return { kept, total };
    }

    /** Undo the latest source migration (restores entry fields + chapter rows). */
    rollbackMigration(entryId: number): boolean {
        const snapshot = this._get<{ id: number; data: string }>(
            'SELECT * FROM entry_snapshots WHERE entry_id = ? ORDER BY id DESC LIMIT 1',
            entryId
        );
        if (!snapshot) {
            return false;
        }
        const data = JSON.parse(snapshot.data) as { entry: EntryRow; chapters: ChapterRow[] };
        this.opts.db.db.prepare(
            `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                    migration_suggestion = NULL, check_failures = 0 WHERE id = ?`
        ).run(data.entry.source_id, data.entry.source_label, data.entry.manga_id, data.entry.title, data.entry.url, entryId);
        this.opts.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
        const insert = this.opts.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
        for (const chapter of data.chapters) {
            insert.run(entryId, chapter.chapter_id, chapter.title, chapter.language, chapter.status, chapter.path,
                chapter.discovered_at, chapter.downloaded_at);
        }
        this.opts.db.db.prepare('DELETE FROM entry_snapshots WHERE id = ?').run(snapshot.id);
        return true;
    }

    // ------------------------------------------------------------------
    // chapters
    // ------------------------------------------------------------------

    /**
     * Fetch the current chapter list from the source and store any chapter
     * that is not known yet (status 'new'). Returns the new chapters.
     */
    async checkForNewChapters(entryId: number): Promise<{ fresh: ChapterRow[]; usableSeen: number }> {
        const row = this._getEntryRow(entryId);
        if (!row) {
            throw new Error(`Library entry ${entryId} not found`);
        }
        const source = await this.opts.registry.get(row.source_id);
        if (!source) {
            throw new Error(`Source "${row.source_id}" not found`);
        }
        const chapters = await source.getChapters({ id: row.manga_id, title: row.title });
        const now = new Date().toISOString();
        const insert = this.opts.db.db.prepare(SQL_INSERT_NEW_CHAPTER);
        const fresh: ChapterRow[] = [];
        const preferred = this.opts.getPreferredLanguages?.() || [];
        let usableSeen = 0;
        for (const chapter of chapters) {
            if (!chapterAllowed(chapter.language, preferred)) {
                continue;
            }
            usableSeen++;
            const result = insert.run(entryId, chapter.id, chapter.title, chapter.language || null, now);
            if (Number(result.changes) > 0) {
                fresh.push({
                    id: Number(result.lastInsertRowid),
                    entry_id: entryId,
                    chapter_id: chapter.id,
                    title: chapter.title,
                    language: chapter.language || null,
                    status: 'new',
                    path: null,
                    discovered_at: now,
                    downloaded_at: null
                });
            }
        }
        this.opts.db.db.prepare('UPDATE library SET last_checked_at = ? WHERE id = ?').run(now, entryId);
        return { fresh, usableSeen };
    }

    /** Enqueue all chapters with status 'new' into the download queue. */
    enqueueNewChapters(entryId: number, queue: DownloadQueue): number {
        const entry = this._getEntryRow(entryId);
        if (!entry) {
            return 0;
        }
        const chapters = this._all<ChapterRow>(
            'SELECT * FROM library_chapters WHERE entry_id = ? AND status = ? ORDER BY discovered_at ASC',
            entryId, 'new'
        );
        const markQueued = () => {
            this.opts.db.db.prepare(
                'UPDATE library_chapters SET status = ? WHERE entry_id = ? AND status = ?'
            ).run('queued', entryId, 'new');
        };
        return this._enqueueSelected(entry, chapters, queue, markQueued);
    }

    /** Enqueue a specific set of chapters (used by the scheduler for the fresh diff only). */
    enqueueChapters(entryId: number, chapterIds: string[], queue: DownloadQueue): number {
        const entry = this._getEntryRow(entryId);
        if (!entry || chapterIds.length === 0) {
            return 0;
        }
        const placeholders = chapterIds.map(() => '?').join(', ');
        const chapters = this._all<ChapterRow>(
            `SELECT * FROM library_chapters WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status = 'new'`,
            entryId, ...chapterIds
        );
        const markQueued = () => {
            this.opts.db.db.prepare(
                `UPDATE library_chapters SET status = 'queued' WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status = 'new'`
            ).run(entryId, ...chapterIds);
        };
        return this._enqueueSelected(entry, chapters, queue, markQueued);
    }

    /** Called by the download queue / import / failover when a chapter changes. */
    markChapter(entryId: number, chapterId: string, status: 'downloaded' | 'failed' | 'new', filePath?: string, origin = 'download'): void {
        const previous = this._get<{ title: string; status: string; path: string | null }>(
            'SELECT title, status, path FROM library_chapters WHERE entry_id = ? AND chapter_id = ?',
            entryId, chapterId
        );
        this.opts.db.db.prepare(
            'UPDATE library_chapters SET status = ?, path = ?, downloaded_at = ? WHERE entry_id = ? AND chapter_id = ?'
        ).run(status, filePath || null, status === 'downloaded' ? new Date().toISOString() : null, entryId, chapterId);
        if (previous && (previous.status !== status || previous.path !== (filePath || null))) {
            this._recordChapterHistory(entryId, chapterId, previous.title, origin, previous.status, previous.path, status, filePath || null);
        }
    }

    /** Full change history of an entry's chapters (newest first). */
    chapterHistory(entryId: number, chapterId?: string): Array<Record<string, unknown>> {
        if (chapterId) {
            return this._all<Record<string, unknown>>('SELECT * FROM chapter_history WHERE entry_id = ? AND chapter_id = ? ORDER BY id DESC', entryId, chapterId);
        }
        return this._all<Record<string, unknown>>('SELECT * FROM chapter_history WHERE entry_id = ? ORDER BY id DESC LIMIT 200', entryId);
    }

    /** Restore a chapter to its previous downloaded file (latest history entry with a previous path). */
    rollbackChapter(entryId: number, chapterId: string): boolean {
        const last = this._get<{ old_path: string }>(
            `SELECT old_path FROM chapter_history
             WHERE entry_id = ? AND chapter_id = ? AND old_status = 'downloaded' AND old_path IS NOT NULL
             ORDER BY id DESC LIMIT 1`,
            entryId, chapterId
        );
        if (!last?.old_path || !fs.existsSync(last.old_path)) {
            return false;
        }
        this.markChapter(entryId, chapterId, 'downloaded', last.old_path, 'rollback');
        return true;
    }

    listChapters(entryId: number): LibraryChapterDto[] {
        const rows = this._all<ChapterRow & { history_count: number }>(
            `SELECT c.*, (SELECT COUNT(*) FROM chapter_history h WHERE h.entry_id = c.entry_id AND h.chapter_id = c.chapter_id) AS history_count
             FROM library_chapters c WHERE entry_id = ? ORDER BY discovered_at DESC, id DESC`,
            entryId
        );
        return rows.map(row => ({
            id: row.id,
            entryId: row.entry_id,
            chapterId: row.chapter_id,
            title: row.title,
            language: row.language || undefined,
            status: row.status,
            path: row.path || undefined,
            discoveredAt: row.discovered_at,
            downloadedAt: row.downloaded_at || undefined,
            historyCount: Number(row.history_count || 0)
        }));
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    private _getEntryRow(entryId: number): EntryRow | undefined {
        return this._get<EntryRow>('SELECT * FROM library WHERE id = ?', entryId);
    }

    /** Typed SQLite query helpers (node:sqlite returns untyped rows). */
    private _all<T>(sql: string, ...params: Array<string | number | null>): T[] {
        return this.opts.db.db.prepare(sql).all(...params) as unknown as T[];
    }

    private _get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
        return this.opts.db.db.prepare(sql).get(...params) as unknown as T | undefined;
    }

    /** Queue the selected chapters and flip them to 'queued'; returns the queued count. */
    private _enqueueSelected(entry: EntryRow, chapters: ChapterRow[], queue: DownloadQueue, markQueued: () => void): number {
        // the empty guard matters: queue.enqueue([]) would still trigger a scheduler tick
        if (chapters.length === 0) {
            return 0;
        }
        queue.enqueue(chapters.map(chapter => this._toQueueItem(entry, chapter)));
        markQueued();
        return chapters.length;
    }

    private _toQueueItem(entry: EntryRow, chapter: ChapterRow): { sourceId: string; mangaId: string; mangaTitle: string; chapterId: string; chapterTitle: string; entryId: number } {
        return {
            sourceId: entry.source_id,
            mangaId: entry.manga_id,
            mangaTitle: entry.title,
            chapterId: chapter.chapter_id,
            chapterTitle: chapter.title,
            entryId: entry.id
        };
    }

    private _recordChapterHistory(entryId: number, chapterId: string, title: string, event: string,
        oldStatus: string | null, oldPath: string | null, newStatus: string, newPath: string | null): void {
        this.opts.db.db.prepare(
            `INSERT INTO chapter_history (entry_id, chapter_id, title, event, old_status, old_path, new_status, new_path, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(entryId, chapterId, title, event, oldStatus, oldPath, newStatus, newPath, new Date().toISOString());
    }

    private _snapshotEntry(entryId: number, reason: string): void {
        const entry = this._getEntryRow(entryId);
        if (!entry) {
            return;
        }
        const chapters = this._all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId);
        this.opts.db.db.prepare(
            'INSERT INTO entry_snapshots (entry_id, reason, data, at) VALUES (?, ?, ?, ?)'
        ).run(entryId, reason, JSON.stringify({ entry, chapters }), new Date().toISOString());
    }

    private _migrate(): void {
        this.opts.db.db.exec(`
            CREATE TABLE IF NOT EXISTS library (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id           TEXT NOT NULL,
                source_label        TEXT NOT NULL,
                manga_id            TEXT NOT NULL,
                title               TEXT NOT NULL,
                url                 TEXT,
                thumbnail           TEXT,
                auto_download       INTEGER NOT NULL DEFAULT 1,
                check_failures      INTEGER NOT NULL DEFAULT 0,
                migration_suggestion TEXT,
                last_checked_at     TEXT,
                added_at            TEXT NOT NULL,
                UNIQUE(source_id, manga_id)
            );
            CREATE TABLE IF NOT EXISTS library_chapters (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id      INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
                chapter_id    TEXT NOT NULL,
                title         TEXT NOT NULL,
                language      TEXT,
                status        TEXT NOT NULL DEFAULT 'new',
                path          TEXT,
                discovered_at TEXT NOT NULL,
                downloaded_at TEXT,
                UNIQUE(entry_id, chapter_id)
            );
            CREATE INDEX IF NOT EXISTS idx_library_chapters_entry ON library_chapters(entry_id, status);
            CREATE TABLE IF NOT EXISTS chapter_history (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id   INTEGER NOT NULL,
                chapter_id TEXT NOT NULL,
                title      TEXT NOT NULL,
                event      TEXT NOT NULL,
                old_status TEXT,
                old_path   TEXT,
                new_status TEXT,
                new_path   TEXT,
                at         TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chapter_history ON chapter_history(entry_id, chapter_id);
            CREATE TABLE IF NOT EXISTS entry_snapshots (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_id INTEGER NOT NULL,
                reason   TEXT NOT NULL,
                data     TEXT NOT NULL,
                at       TEXT NOT NULL
            );
        `);

        // existing databases: add columns when missing
        const columns = this.opts.db.db.prepare('PRAGMA table_info(library)').all() as Array<{ name: string }>;
        this._addColumn(columns, 'thumbnail', 'thumbnail TEXT');
        this._addColumn(columns, 'check_failures', 'check_failures INTEGER NOT NULL DEFAULT 0');
        this._addColumn(columns, 'migration_suggestion', 'migration_suggestion TEXT');
        this._addColumn(columns, 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
        this._addColumn(columns, 'download_failures', 'download_failures INTEGER NOT NULL DEFAULT 0');
    }

    /** ALTER TABLE helper: adds `ddl` (must reference `name`) when the column is missing. */
    private _addColumn(columns: Array<{ name: string }>, name: string, ddl: string): void {
        if (!columns.some(column => column.name === name)) {
            this.opts.db.db.exec(`ALTER TABLE library ADD COLUMN ${ddl}`);
        }
    }

    private _isDownloaded(sourceLabel: string, mangaTitle: string, chapterTitle: string): boolean {
        const paths = chapterPaths(this.opts.queueSettings.dataDirectory, sourceLabel, mangaTitle, chapterTitle, this.opts.queueSettings.directoryLayout);
        return outputExists(paths, this.opts.queueSettings.chapterFormat);
    }

    private _entryToDto(row: EntryRow): LibraryEntryDto {
        const counts = this._get<{ total: number | null; downloaded: number | null; fresh: number | null }>(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded,
                    SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh
             FROM library_chapters WHERE entry_id = ?`,
            row.id
        )!;
        const snapshot = this._get<{ n: number }>('SELECT COUNT(*) AS n FROM entry_snapshots WHERE entry_id = ?', row.id)!;
        let suggestion: LibraryEntryDto['migrationSuggestion'];
        try {
            suggestion = row.migration_suggestion ? JSON.parse(row.migration_suggestion) : undefined;
        } catch {
            suggestion = undefined;
        }
        return {
            id: row.id,
            sourceId: row.source_id,
            sourceLabel: row.source_label,
            mangaId: row.manga_id,
            title: row.title,
            thumbnail: row.thumbnail || undefined,
            autoDownload: row.auto_download === 1,
            chapterCount: Number(counts.total || 0),
            downloadedCount: Number(counts.downloaded || 0),
            newCount: Number(counts.fresh || 0),
            lastCheckedAt: row.last_checked_at || undefined,
            addedAt: row.added_at,
            checkFailures: Number(row.check_failures || 0),
            migrationSuggestion: suggestion,
            canRollbackMigration: Number(snapshot.n || 0) > 0,
            hidden: Number(row.hidden || 0) === 1
        };
    }
}
