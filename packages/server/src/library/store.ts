/**
 * Library store: tracked series + their known chapters.
 * The scheduler diffs the source's chapter list against this store to find
 * new chapters; the download queue reports back through markChapter().
 *
 * The store is a facade over focused modules: schema.ts (tables/migrations),
 * outages.ts (source health + staleness), chapters.ts (chapter checks,
 * enqueue, history/rollback) and migration.ts (source migrations). Entry
 * CRUD and DTO mapping live here.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceRegistry } from '@tanko/core';
import type { DeadSeriesDto, LibraryEntryDto } from '@tanko/shared';
import type { Database } from '../db.js';
import { countLocalChapters } from '../downloader/paths.js';
import type { DownloadQueue, QueueSettings } from '../downloader/queue.js';
import { chapterAllowed } from '../languages.js';
import * as chapters from './chapters.js';
import type { StoreContext } from './context.js';
import { getEntryRow, isDownloaded, makeQueries, seriesDirectory } from './context.js';
import * as directories from './directories.js';
import * as migration from './migration.js';
import * as outages from './outages.js';
import type { AlternativeRow, ChapterRow, EntryRow, MigrationTarget, SourceOutage, StalledCandidate } from './rows.js';
import { normalizeAliases, normalizeTitle, SQL_INSERT_CHAPTER } from './rows.js';
import { migrateLibrarySchema } from './schema.js';

export type { AlternativeRow, ChapterRow, MigrationTarget, SourceOutage, StalledCandidate };

export class LibraryStore {
    private readonly ctx: StoreContext;

    constructor(opts: {
        db: Database;
        registry: SourceRegistry;
        queueSettings: QueueSettings;
        /** Preferred chapter languages (ISO codes); empty = keep everything. */
        getPreferredLanguages?: () => string[];
    }) {
        this.ctx = {
            db: opts.db,
            q: makeQueries(opts.db),
            registry: opts.registry,
            queueSettings: opts.queueSettings,
            getPreferredLanguages: opts.getPreferredLanguages
        };
        migrateLibrarySchema(opts.db);
        // give legacy rows their canonical directory before anything reads it
        directories.backfillDirectories(this.ctx);
    }
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
        /** 'ignore' snapshots the existing catalog as 'missing' (monitor-only);
         *  'grab' (default) keeps it 'new' so it can be queued right away. */
        backlog?: 'ignore' | 'grab';
    }): Promise<{ entry: LibraryEntryDto; snapshot: number }> {
        const source = await this.ctx.registry.get(entry.sourceId);
        if (!source) {
            throw new Error(`Source "${entry.sourceId}" not found`);
        }
        const now = new Date().toISOString();
        const directory = directories.allocateDirectory(this.ctx, {
            title: entry.title,
            sourceLabel: source.label,
            layout: this.ctx.queueSettings.directoryLayout
        });
        const result = this.ctx.q.get<{ id: number }>(
            `INSERT INTO library (source_id, source_label, manga_id, title, url, thumbnail, auto_download, last_checked_at, last_chapter_at, added_at, directory)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_id, manga_id) DO UPDATE SET title = excluded.title, url = excluded.url,
                thumbnail = COALESCE(excluded.thumbnail, library.thumbnail),
                last_chapter_at = excluded.last_chapter_at
             RETURNING id`,
            entry.sourceId,
            source.label,
            entry.mangaId,
            entry.title,
            entry.url || null,
            entry.thumbnail || null,
            entry.autoDownload === false ? 0 : 1,
            now,
            now,
            now,
            directory
        );
        if (!result) {
            throw new Error(`Failed to create the library entry for "${entry.title}"`);
        }

        let snapshot = 0;
        try {
            const chaptersFound = await source.getChapters({ id: entry.mangaId, title: entry.title });
            const insert = this.ctx.db.db.prepare(SQL_INSERT_CHAPTER);
            const preferred = this.ctx.getPreferredLanguages?.() || [];
            for (const chapter of chaptersFound) {
                if (!chapterAllowed(chapter.language, preferred)) {
                    continue;
                }
                let status: 'downloaded' | 'missing' | 'new';
                if (isDownloaded(this.ctx, source.label, entry.title, chapter.title, { id: result.id, directory })) {
                    status = 'downloaded';
                } else if (entry.backlog === 'ignore') {
                    status = 'missing';
                } else {
                    status = 'new';
                }
                insert.run(result.id, chapter.id, chapter.title, chapter.language || null, status, now);
                snapshot++;
            }
        } catch (error) {
            console.warn(`[library] initial snapshot failed for "${entry.title}":`, (error as Error).message);
        }
        const created = this.getEntry(result.id);
        if (!created) {
            throw new Error(`Entry "${entry.title}" vanished right after its insert`);
        }
        return { entry: created, snapshot };
    }

    /** Remove the entry from Tanko; with `disk`, also delete its files — the
     *  whole series folder when no other entry shares it, else only the files
     *  this entry has recorded (a shared folder must survive its co-tenants). */
    removeEntry(entryId: number, options: { disk?: boolean } = {}): { ok: boolean; deletedPath?: string; deletedFiles?: number } {
        const row = getEntryRow(this.ctx, entryId);
        // before the delete: chapter paths vanish with the entry (cascade)
        const directory = options.disk && row ? seriesDirectory(this.ctx, entryId, row) : null;
        const shared = directory != null && this._directoryShared(directory, entryId);
        // recorded before the cascade; only the shared branch needs them
        const recordedPaths = shared
            ? this.ctx.q
                  .all<{ path: string }>('SELECT path FROM library_chapters WHERE entry_id = ? AND path IS NOT NULL AND length(path) > 0', entryId)
                  .map(item => item.path)
            : [];
        this.purgeJournals(entryId);
        const result = this.ctx.db.db.prepare('DELETE FROM library WHERE id = ?').run(entryId);
        if (Number(result.changes) === 0) {
            return { ok: false };
        }
        if (!directory || !fs.existsSync(directory)) {
            return { ok: true };
        }
        return shared ? this._deleteSharedFiles(recordedPaths, entryId) : this._deleteSeriesFolder(directory);
    }

    /** Delete the files this entry recorded in a shared folder — only those no
     *  other entry also claims, and never outside the data directory. */
    private _deleteSharedFiles(recordedPaths: string[], entryId: number): { ok: boolean; deletedFiles: number } {
        const base = path.resolve(this.ctx.queueSettings.dataDirectory);
        const claimed = new Set(
            this.ctx.q
                .all<{ path: string }>('SELECT path FROM library_chapters WHERE entry_id != ? AND path IS NOT NULL AND length(path) > 0', entryId)
                .map(item => path.resolve(item.path))
        );
        let deletedFiles = 0;
        for (const file of recordedPaths) {
            const target = path.resolve(file);
            if (claimed.has(target) || !target.startsWith(base + path.sep)) {
                continue;
            }
            try {
                // 'img' format records a chapter DIRECTORY as its path
                fs.rmSync(file, { force: true, recursive: true });
                deletedFiles++;
            } catch {
                // keep going: the entry is gone regardless
            }
        }
        return { ok: true, deletedFiles };
    }

    /** Delete the whole series folder, confined inside the data directory. */
    private _deleteSeriesFolder(directory: string): { ok: boolean; deletedPath?: string } {
        const base = path.resolve(this.ctx.queueSettings.dataDirectory);
        const target = path.resolve(directory);
        if (target === base || !target.startsWith(base + path.sep)) {
            console.warn(`[library] refusing to delete outside the data directory: ${directory}`);
            return { ok: true };
        }
        try {
            // check first so deletedPath only reports a folder actually removed
            fs.rmSync(directory, { recursive: true, force: true });
            return { ok: true, deletedPath: directory };
        } catch {
            // entry is gone even if the folder could not be removed
            return { ok: true };
        }
    }

    /** Whether another entry's files also live in this directory (resolved
     *  series directories already tolerate apostrophe and case variants). */
    private _directoryShared(directory: string, entryId: number): boolean {
        const target = path.resolve(directory);
        const rows = this.ctx.q.all<{ id: number }>('SELECT id FROM library WHERE id != ?', entryId);
        return rows.some(row => {
            const other = seriesDirectory(this.ctx, row.id);
            return other != null && path.resolve(other) === target;
        });
    }

    /** No FK on the journal tables: explicit cleanup for a removed entry. */
    private purgeJournals(entryId: number): void {
        this.ctx.db.db.prepare('DELETE FROM chapter_history WHERE entry_id = ?').run(entryId);
        this.ctx.db.db.prepare('DELETE FROM entry_snapshots WHERE entry_id = ?').run(entryId);
    }
    /** Directory holding the entry's files: deepest common ancestor of the
     *  downloaded chapter paths, falling back to the configured layout. */
    seriesDirectory(entryId: number, row?: EntryRow): string | null {
        return seriesDirectory(this.ctx, entryId, row);
    }

    /** Disk sync pass: re-attach local chapter files to the database. Every
     *  entry's series folder is matched against its chapters by number and a
     *  matching file marks its chapter downloaded (a check that ran while the
     *  files lived elsewhere, a manual move, a restore…). Entries with no
     *  chapter rows at all (import whose sync failed, files pre-dating the
     *  database) get a source check first so there are rows to attach to;
     *  chapters that stay unattached are genuinely missing from disk. */
    async resyncLocalFiles(shouldCancel?: () => boolean): Promise<{ attached: number; entries: number; checked: number }> {
        let attached = 0;
        let entries = 0;
        let checked = 0;
        for (const row of this.ctx.q.all<EntryRow>('SELECT * FROM library')) {
            if (shouldCancel?.()) {
                break;
            }
            const directory = seriesDirectory(this.ctx, row.id, row);
            if (!directory) {
                continue;
            }
            const byNumber = migration.diskByNumber(directory);
            if (byNumber.size === 0) {
                continue;
            }
            const count = this.ctx.q.get<{ n: number }>('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?', row.id);
            if (Number(count?.n ?? 0) === 0) {
                try {
                    await chapters.checkForNewChapters(this.ctx, row.id);
                    checked++;
                } catch {
                    // source unreachable: keep the disk-only pass — the
                    // display counts local files even without DB rows
                }
            }
            const { attached: matched, registered } = chapters.registerLocalChapters(this.ctx, row.id, byNumber);
            if (matched + registered > 0) {
                attached += matched + registered;
                entries++;
            }
        }
        return { attached, entries, checked };
    }

    /** Sync helper for the dashboard: entries whose files vanished from disk
     *  (e.g. a series folder deleted directly on the NAS). An entry is dead only
     *  when it has downloaded chapters on record and neither its series folder
     *  nor any recorded chapter file exists anymore; series with nothing
     *  downloaded keep their expected folder layout and are never reported. */
    findDeadEntries(): DeadSeriesDto[] {
        const dead: DeadSeriesDto[] = [];
        for (const row of this.ctx.q.all<EntryRow>('SELECT * FROM library')) {
            const directory = this._deadDirectory(row);
            if (directory !== undefined) {
                dead.push({ id: row.id, title: row.title, directory });
            }
        }
        return dead;
    }

    /** Remove entries identified by findDeadEntries(); nothing is deleted on
     *  disk (the files are already gone). Each id is re-validated against the
     *  current disk state — a download completed since the dry-run keeps its
     *  entry. Returns the number of entries removed. */
    pruneEntries(ids: number[]): number {
        let removed = 0;
        for (const id of ids) {
            const row = getEntryRow(this.ctx, id);
            if (!row || this._deadDirectory(row) === undefined) {
                continue;
            }
            this.purgeJournals(id);
            removed += Number(this.ctx.db.db.prepare('DELETE FROM library WHERE id = ?').run(id).changes);
        }
        return removed;
    }

    /** The entry's last known folder when its files are gone from disk,
     *  undefined when the entry is still alive (or has nothing downloaded). */
    private _deadDirectory(row: EntryRow): string | null | undefined {
        const paths = this.ctx.q
            .all<{ path: string }>(
                `SELECT path FROM library_chapters
                 WHERE entry_id = ? AND status = 'downloaded' AND path IS NOT NULL AND length(path) > 0`,
                row.id
            )
            .map(item => item.path);
        if (paths.length === 0) {
            return undefined;
        }
        const directory = seriesDirectory(this.ctx, row.id, row);
        const alive = (directory !== null && fs.existsSync(directory)) || paths.some(item => fs.existsSync(item));
        return alive ? undefined : directory;
    }

    getEntry(entryId: number): LibraryEntryDto | undefined {
        const row = getEntryRow(this.ctx, entryId);
        return row ? this._entryToDto(row) : undefined;
    }

    async listEntries(filter: 'visible' | 'hidden' | 'all' = 'visible'): Promise<LibraryEntryDto[]> {
        const where = filter === 'visible' ? 'WHERE hidden = 0' : filter === 'hidden' ? 'WHERE hidden = 1' : '';
        const rows = this.ctx.q.all<EntryRow>(`SELECT * FROM library ${where} ORDER BY title COLLATE NOCASE ASC`);
        return Promise.all(rows.map(row => this._entryToDto(row)));
    }

    /** Monitored entries (scheduler checks, detection passes): visible and not paused. */
    async listFollowedEntries(): Promise<LibraryEntryDto[]> {
        const rows = this.ctx.q.all<EntryRow>('SELECT * FROM library WHERE hidden = 0 AND paused = 0 ORDER BY title COLLATE NOCASE ASC');
        return Promise.all(rows.map(row => this._entryToDto(row)));
    }

    /** Hide (or restore) an entry without touching its files: a hidden entry
     *  leaves the default library list and the scheduler. Restoring also
     *  refreshes the last-new-chapter date: a series watched again gets a
     *  fresh stale period instead of being paused right away. */
    setHidden(entryId: number, hidden: boolean): boolean {
        const sql = 'UPDATE library SET hidden = 1 WHERE id = ?';
        const restoreSql = 'UPDATE library SET hidden = 0, last_chapter_at = ? WHERE id = ?';
        const result = hidden ? this.ctx.db.db.prepare(sql).run(entryId) : this.ctx.db.db.prepare(restoreSql).run(new Date().toISOString(), entryId);
        return Number(result.changes) > 0;
    }

    /** Pause (or resume) monitoring: a paused entry stays visible — hiding is
     *  a manual, visual decision only. Resuming refreshes the last-new-chapter
     *  date (fresh stale period) and clears the stalled-probe back-off. */
    setPaused(entryId: number, paused: boolean): boolean {
        const sql = 'UPDATE library SET paused = 1 WHERE id = ?';
        const resumeSql = 'UPDATE library SET paused = 0, last_chapter_at = ?, staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?';
        const result = paused ? this.ctx.db.db.prepare(sql).run(entryId) : this.ctx.db.db.prepare(resumeSql).run(new Date().toISOString(), entryId);
        return Number(result.changes) > 0;
    }

    setAutoDownload(entryId: number, autoDownload: boolean): boolean {
        const result = this.ctx.db.db.prepare('UPDATE library SET auto_download = ? WHERE id = ?').run(autoDownload ? 1 : 0, entryId);
        return Number(result.changes) > 0;
    }

    /** Replace the failover search aliases (manual editor or AniList merge).
     *  Returns what was actually kept, after normalization. */
    setAliases(entryId: number, aliases: ReadonlyArray<string>): string[] {
        const row = getEntryRow(this.ctx, entryId);
        if (!row) {
            throw new Error(`Library entry ${entryId} not found`);
        }
        const normalized = normalizeAliases(row.title, aliases);
        this.ctx.db.db.prepare('UPDATE library SET aliases = ? WHERE id = ?').run(normalized.length > 0 ? JSON.stringify(normalized) : null, entryId);
        return normalized;
    }

    /** Find the library entry tracking a given manga on a source (null when untracked). */
    findEntryByManga(sourceId: string, mangaId: string): EntryRow | null {
        return this.ctx.q.get<EntryRow>('SELECT * FROM library WHERE source_id = ? AND manga_id = ?', sourceId, mangaId) ?? null;
    }

    /** Find a tracked entry by normalized title across every source (hidden
     *  ones included): a follow or import must not silently create a second
     *  entry for a series already tracked under a slightly different title
     *  on another source (re-import matching drift). Null when untracked. */
    findEntryByTitle(title: string): EntryRow | null {
        const needle = normalizeTitle(title);
        if (!needle) {
            return null;
        }
        return this.ctx.q.all<EntryRow>('SELECT * FROM library').find(row => normalizeTitle(row.title) === needle) ?? null;
    }

    /** Record an alternative provenance for the entry's work — the same
     *  series on another source, or another manga id on the same source
     *  (second team, retranslation). The failover prefers these candidates
     *  and the dashboard offers a manual migration to one. The alternative's
     *  title joins the search aliases so the failover finds it under either
     *  spelling. */
    async addAlternative(entryId: number, target: { sourceId: string; mangaId: string; title: string; url?: string }): Promise<AlternativeRow | undefined> {
        const entry = getEntryRow(this.ctx, entryId);
        if (!entry) {
            return undefined;
        }
        const source = await this.ctx.registry.get(target.sourceId);
        if (!source) {
            throw new Error(`Source "${target.sourceId}" not found`);
        }
        this.ctx.db.db
            .prepare(
                `INSERT INTO library_alternatives (entry_id, source_id, source_label, manga_id, title, url, added_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(entry_id, source_id, manga_id) DO UPDATE SET title = excluded.title, url = COALESCE(excluded.url, library_alternatives.url)`
            )
            .run(entryId, target.sourceId, source.label, target.mangaId, target.title, target.url || null, new Date().toISOString());
        const aliases = normalizeAliases(entry.title, [...(JSON.parse(entry.aliases ?? '[]') as string[]), target.title]);
        if (aliases.length > 0) {
            this.ctx.db.db.prepare('UPDATE library SET aliases = ? WHERE id = ?').run(JSON.stringify(aliases), entryId);
        }
        return this.listAlternatives(entryId).find(row => row.source_id === target.sourceId && row.manga_id === target.mangaId);
    }

    listAlternatives(entryId: number): AlternativeRow[] {
        return this.ctx.q.all<AlternativeRow>('SELECT * FROM library_alternatives WHERE entry_id = ? ORDER BY added_at ASC', entryId);
    }

    removeAlternative(entryId: number, alternativeId: number): boolean {
        const result = this.ctx.db.db.prepare('DELETE FROM library_alternatives WHERE id = ? AND entry_id = ?').run(alternativeId, entryId);
        return Number(result.changes) > 0;
    }

    /** The entry tracking this exact provenance, when any (duplicate add of
     *  the same source+manga: an upsert, never a second entry). */
    getEntryByProvenance(sourceId: string, mangaId: string): EntryRow | null {
        return this.ctx.q.get('SELECT * FROM library WHERE source_id = ? AND manga_id = ?', sourceId, mangaId) ?? null;
    }

    /** Point the entry at an existing folder (import adoption): the scanned
     *  path becomes its canonical directory when it lies inside the data
     *  directory — downloads then complete the imported folder in place.
     *  Returns the stored directory, null when the folder is outside. */
    adoptDirectory(entryId: number, folder: string): string | null {
        const rel = directories.relativeOrNull(this.ctx.queueSettings.dataDirectory, folder);
        if (!rel) {
            return null;
        }
        this.ctx.db.db.prepare('UPDATE library SET directory = ? WHERE id = ?').run(rel, entryId);
        return rel;
    }

    /** Download failures since the last failover probe (the probe resets the counter). */
    recordDownloadFailure(entryId: number): number {
        return outages.recordDownloadFailure(this.ctx, entryId);
    }

    resetDownloadFailures(entryId: number): void {
        outages.resetDownloadFailures(this.ctx, entryId);
    }

    /** Distinct entries of this source with a failed download job inside the window. */
    countRecentSourceFailures(sourceId: string, windowMs: number): number {
        return outages.countRecentSourceFailures(this.ctx, sourceId, windowMs);
    }

    /** Entries of this source currently failing their checks. */
    countEntriesWithCheckFailures(sourceId: string): number {
        return outages.countEntriesWithCheckFailures(this.ctx, sourceId);
    }

    /** Note a failure on the source-outage record; arms the escalation stamp
     *  when the outage has lasted long enough — idempotent. */
    noteSourceFailure(sourceId: string, open: boolean): SourceOutage | undefined {
        return outages.noteSourceFailure(this.ctx, sourceId, open);
    }

    getSourceOutage(sourceId: string): SourceOutage | undefined {
        return outages.getSourceOutage(this.ctx, sourceId);
    }

    /** Every open outage (scheduler maintenance: silence-close, escalation). */
    listSourceOutages(): SourceOutage[] {
        return outages.listSourceOutages(this.ctx);
    }

    /** Close an outage (source healed); a quick reopen resumes the wave. */
    closeSourceOutage(sourceId: string): boolean {
        return outages.closeSourceOutage(this.ctx, sourceId);
    }

    /** Arm the escalation stamp of an open outage whose started_at is old enough. */
    armOutageEscalation(sourceId: string): SourceOutage | undefined {
        return outages.armOutageEscalation(this.ctx, sourceId);
    }

    /** Entries whose downloads keep failing (candidates for a source failover). */
    listDownloadFailing(minimum: number): Array<{ id: number; sourceId: string; title: string; downloadFailures: number }> {
        return outages.listDownloadFailing(this.ctx, minimum);
    }

    /** Entries with no new chapter for more than `maxAgeDays` (stale-series auto-pause). */
    listStaleEntries(maxAgeDays: number): Array<{ id: number; title: string; lastChapterAt: string }> {
        return outages.listStaleEntries(this.ctx, maxAgeDays);
    }

    /** Stalled-series probe candidates for the failover's "stalled" regime. */
    listStalledCandidates(): StalledCandidate[] {
        return outages.listStalledCandidates(this.ctx);
    }

    /** Record the outcome of a stalled-source probe (back-off on miss). */
    recordStalenessProbe(entryId: number, hit: boolean): void {
        outages.recordStalenessProbe(this.ctx, entryId, hit);
    }

    recordCheckFailure(entryId: number): number {
        return outages.recordCheckFailure(this.ctx, entryId);
    }

    resetCheckFailures(entryId: number): void {
        outages.resetCheckFailures(this.ctx, entryId);
    }

    /** Fetch the current chapter list from the source and store any chapter
     *  that is not known yet (status 'new'). Returns the new chapters. */
    checkForNewChapters(entryId: number): Promise<{ fresh: ChapterRow[]; usableSeen: number }> {
        return chapters.checkForNewChapters(this.ctx, entryId);
    }

    /** Enqueue every not-yet-downloaded chapter into the download queue. */
    enqueueNewChapters(entryId: number, queue: DownloadQueue, includeMissing = false): number {
        return chapters.enqueueNewChapters(this.ctx, entryId, queue, includeMissing);
    }

    /** Enqueue a specific set of chapters (scheduler fresh diff only). */
    enqueueChapters(entryId: number, chapterIds: string[], queue: DownloadQueue): number {
        return chapters.enqueueChapters(this.ctx, entryId, chapterIds, queue);
    }

    /** Attach local files to an entry's chapters by number, registering the
     *  files the source never listed as local-only rows. */
    registerLocalChapters(entryId: number, localByNumber: Map<number, string>): { attached: number; registered: number } {
        return chapters.registerLocalChapters(this.ctx, entryId, localByNumber);
    }

    /** Attach local files to a tracked entry's chapters by number (re-import). */
    markDownloadedByNumber(entryId: number, localByNumber: Map<number, string>): number {
        return chapters.markDownloadedByNumber(this.ctx, entryId, localByNumber);
    }

    /** Flag tracked chapters as queued after an ad-hoc enqueue. */
    markChaptersQueued(entryId: number, chapterIds: string[]): number {
        return chapters.markChaptersQueued(this.ctx, entryId, chapterIds);
    }

    /** A cancelled download reverts a still-queued chapter to its pre-queue status. */
    revertCancelledChapter(entryId: number, chapterId: string): void {
        chapters.revertCancelledChapter(this.ctx, entryId, chapterId);
    }

    /** Bulk variant of revertCancelledChapter for cleared queues. */
    revertClearedChapters(pairs: Array<{ entryId: number; chapterId: string }>): void {
        chapters.revertClearedChapters(this.ctx, pairs);
    }

    /** Called by the download queue / import / failover when a chapter changes. */
    markChapter(entryId: number, chapterId: string, status: 'downloaded' | 'failed' | 'new', filePath?: string, origin = 'download'): void {
        chapters.markChapter(this.ctx, entryId, chapterId, status, filePath, origin);
    }

    /** Full change history of an entry's chapters (newest first). */
    chapterHistory(entryId: number, chapterId?: string): Array<Record<string, unknown>> {
        return chapters.chapterHistory(this.ctx, entryId, chapterId);
    }

    /** Restore a chapter to its previous downloaded file. */
    rollbackChapter(entryId: number, chapterId: string): boolean {
        return chapters.rollbackChapter(this.ctx, entryId, chapterId);
    }

    listChapters(entryId: number) {
        return chapters.listChapters(this.ctx, entryId);
    }

    setMigrationSuggestion(entryId: number, suggestion: MigrationTarget | null): void {
        migration.setMigrationSuggestion(this.ctx, entryId, suggestion);
    }

    /** Dismiss a suggestion AND remember the refusal. */
    dismissMigrationSuggestion(entryId: number, suggestion: MigrationTarget): void {
        migration.dismissMigrationSuggestion(this.ctx, entryId, suggestion);
    }

    /** Move an entry to another source, carrying downloaded files over. */
    migrateEntry(entryId: number, target: MigrationTarget): Promise<{ kept: number; total: number }> {
        return migration.migrateEntry(this.ctx, entryId, target);
    }

    /** Re-queue the chapters that failed on the old source after a migration. */
    requeueFailedAfterMigration(entryId: number, queue: DownloadQueue): number {
        return migration.requeueFailedAfterMigration(this.ctx, entryId, queue);
    }

    /** Undo the latest source migration (restores entry fields + chapter rows). */
    rollbackMigration(entryId: number): boolean {
        return migration.rollbackMigration(this.ctx, entryId);
    }

    private _entryToDto(row: EntryRow): LibraryEntryDto {
        const counts = this.ctx.q.get<{ total: number | null; downloaded: number | null; fresh: number | null; failed: number | null; missing: number | null }>(
            `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded,
                        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing
                 FROM library_chapters WHERE entry_id = ?`,
            row.id
        ) ?? { total: null, downloaded: null, fresh: null, failed: null, missing: null };
        const snapshot = this.ctx.q.get<{ n: number }>('SELECT COUNT(*) AS n FROM entry_snapshots WHERE entry_id = ?', row.id) ?? { n: 0 };
        let suggestion: LibraryEntryDto['migrationSuggestion'];
        try {
            suggestion = row.migration_suggestion ? JSON.parse(row.migration_suggestion) : undefined;
        } catch {
            suggestion = undefined;
        }
        let dismissed: LibraryEntryDto['dismissedMigration'];
        try {
            dismissed = row.migration_dismissed ? JSON.parse(row.migration_dismissed) : undefined;
        } catch {
            dismissed = undefined;
        }
        let aliases: string[] | undefined;
        try {
            const parsed: unknown = row.aliases ? JSON.parse(row.aliases) : undefined;
            aliases = Array.isArray(parsed) ? parsed.filter((alias): alias is string => typeof alias === 'string') : undefined;
        } catch {
            aliases = undefined;
        }
        let chapterCount = Number(counts.total || 0);
        let downloadedCount = Number(counts.downloaded || 0);
        // no chapter registered (import whose source-based sync failed,
        // files pre-dating the database): show what actually sits on disk
        if (chapterCount === 0) {
            const directory = seriesDirectory(this.ctx, row.id, row);
            if (directory) {
                downloadedCount = countLocalChapters(directory);
                chapterCount = downloadedCount;
            }
        }
        return {
            id: row.id,
            sourceId: row.source_id,
            sourceLabel: row.source_label,
            mangaId: row.manga_id,
            title: row.title,
            thumbnail: row.thumbnail || undefined,
            autoDownload: row.auto_download === 1,
            chapterCount,
            downloadedCount,
            newCount: Number(counts.fresh || 0),
            failedCount: Number(counts.failed || 0),
            missingCount: Number(counts.missing || 0),
            lastCheckedAt: row.last_checked_at || undefined,
            lastChapterAt: row.last_chapter_at || undefined,
            addedAt: row.added_at,
            checkFailures: Number(row.check_failures || 0),
            migrationSuggestion: suggestion,
            dismissedMigration: dismissed,
            canRollbackMigration: Number(snapshot.n || 0) > 0,
            hidden: Number(row.hidden || 0) === 1,
            paused: Number(row.paused || 0) === 1,
            aliases: aliases && aliases.length > 0 ? aliases : undefined
        };
    }
}
