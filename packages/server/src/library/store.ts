/**
 * Library store: tracked series + their known chapters.
 * The scheduler diffs the source's chapter list against this store to find
 * new chapters; the download queue reports back through markChapter().
 * Every chapter status/path change is journaled in chapter_history (rollback),
 * and source migrations keep a full snapshot in entry_snapshots (undo).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SourceAdapter, SourceRegistry } from '@tanko/core';
import type { DeadSeriesDto, LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import type { Database } from '../db.js';
import { chapterPaths, countLocalChapters, listChapterEntries, outputExists } from '../downloader/paths.js';
import type { DownloadQueue, QueueSettings } from '../downloader/queue.js';
import { parseChapterNumber } from '../import/scanner.js';
import { chapterAllowed } from '../languages.js';
import { withTimeout } from '../util/timeout.js';
// runtime constants only — failover imports *types* from this module, and a
// type-only import is erased at compile time, so no runtime cycle is created
import { OUTAGE_ESCALATION_MS, OUTAGE_SILENCE_MS } from './failover.js';

/** Shared INSERT statements for chapter rows (6-column snapshot, 6-column forced 'new', full 8-column). */
const SQL_INSERT_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, ?, ?)`;
const SQL_INSERT_NEW_CHAPTER = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at)
             VALUES (?, ?, ?, ?, 'new', ?)`;
const SQL_INSERT_CHAPTER_FULL = `INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, path, discovered_at, downloaded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** Stalled-series detection (failover's "stalled" regime): an entry becomes a
 *  probe candidate when its last new chapter is older than
 *  max(STALE_RHYTHM_FACTOR × its own observed rhythm, STALE_FLOOR_DAYS). The
 *  rhythm is learned from the gaps between distinct chapter-discovery events
 *  (a check that finds several chapters counts as one event); too few events
 *  (series imported in bulk) falls back to a fixed STALE_FALLBACK_DAYS. A
 *  probe that finds no richer source (probable hiatus) backs off
 *  exponentially before probing again. */
const DAY_MS = 86_400_000;
/** Rhythm multiplier: stalled = idle for 3 × the series' own median gap. */
const STALE_RHYTHM_FACTOR = 3;
/** Floor: even a fast series must be idle this long before looking stalled. */
const STALE_FLOOR_DAYS = 14;
/** Fallback when too few distinct discovery events exist to learn a rhythm. */
const STALE_FALLBACK_DAYS = 30;
/** Distinct discovery events used to learn the rhythm (their ~12 gaps). */
const STALE_CADENCE_EVENTS = 13;
/** Minimum distinct gaps before the learned rhythm is trusted. */
const STALE_CADENCE_MIN_GAPS = 4;
/** Back-off after a probe that found no richer source: 7d, 14d, 28d… */
const STALE_BACKOFF_BASE_MS = 7 * DAY_MS;
/** …capped so a probable hiatus stops costing probes. */
const STALE_BACKOFF_MAX_MS = 45 * DAY_MS;
/** Case/punctuation-insensitive title key for cross-source duplicate
 *  detection (keeps letters of any script and digits, drops the rest). */
function normalizeTitle(title: string): string {
    return title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks — "Café" == "Cafe" (mirrors similarity.ts)
        .toLowerCase()
        .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** Aliases are stored as a JSON array; normalization mirrors titleSimilarity's
 *  expectations: trimmed, 3–200 chars, deduplicated case-insensitively, never
 *  equal to the entry's own title, capped so a fat-fingered paste cannot
 *  multiply the failover's search queries. */
function normalizeAliases(title: string, aliases: ReadonlyArray<string>): string[] {
    const seen = new Set([normalizeTitle(title)]);
    const kept: string[] = [];
    for (const alias of aliases) {
        const trimmed = alias.trim();
        const key = normalizeTitle(trimmed);
        if (trimmed.length < 3 || trimmed.length > 200 || seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(trimmed);
        if (kept.length >= 10) {
            break;
        }
    }
    return kept;
}

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
    migration_dismissed: string | null;
    hidden: number;
    /** Paused (follow off): the entry stays visible but the scheduler ignores it. */
    paused: number;
    last_checked_at: string | null;
    /** Date the last new chapter was discovered (drives the stale-series auto-pause). */
    last_chapter_at: string | null;
    added_at: string;
    /** Stalled-probe back-off: consecutive probes without a richer source
     *  found, and the earliest date the next probe may run (null = any time). */
    staleness_misses: number;
    staleness_next_probe_at: string | null;
    /** Alternative titles (JSON array) searched by the failover. */
    aliases: string | null;
}

/** A source-wide download outage (≥ SOURCE_OUTAGE_ENTRIES distinct entries
 *  failing inside the window). escalatedAt non-null = the suspension of
 *  migration is lifted: the outage is old enough to look permanent. */
export interface SourceOutage {
    sourceId: string;
    startedAt: string;
    lastSeenAt: string;
    failures: number;
    escalatedAt: string | null;
}

/** Raw row of the source_outages table. */
interface OutageRow {
    source_id: string;
    started_at: string;
    last_seen_at: string;
    failures: number;
    escalated_at: string | null;
    closed_at: string | null;
}

function toOutage(row: OutageRow): SourceOutage {
    return {
        sourceId: row.source_id,
        startedAt: row.started_at,
        lastSeenAt: row.last_seen_at,
        failures: row.failures,
        escalatedAt: row.escalated_at
    };
}
export interface ChapterRow {
    id: number;
    entry_id: number;
    chapter_id: string;
    title: string;
    language: string | null;
    status: 'new' | 'missing' | 'queued' | 'downloading' | 'downloaded' | 'failed';
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

/** Probe candidate of the stalled-source failover regime. */
export interface StalledCandidate {
    id: number;
    sourceId: string;
    title: string;
    chapterCount: number;
}

export class LibraryStore {
    constructor(
        private readonly opts: {
            db: Database;
            registry: SourceRegistry;
            queueSettings: QueueSettings;
            /** Preferred chapter languages (ISO codes); empty = keep everything. */
            getPreferredLanguages?: () => string[];
        }
    ) {
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
        /** 'ignore' snapshots the existing catalog as 'missing' (monitor-only);
         *  'grab' (default) keeps it 'new' so it can be queued right away. */
        backlog?: 'ignore' | 'grab';
    }): Promise<{ entry: LibraryEntryDto; snapshot: number }> {
        const source = await this.opts.registry.get(entry.sourceId);
        if (!source) {
            throw new Error(`Source "${entry.sourceId}" not found`);
        }
        const now = new Date().toISOString();
        const result = this._get<{ id: number }>(
            `INSERT INTO library (source_id, source_label, manga_id, title, url, thumbnail, auto_download, last_checked_at, last_chapter_at, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            now
        );
        if (!result) {
            throw new Error(`Failed to create the library entry for "${entry.title}"`);
        }

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
                const status = this._isDownloaded(source.label, entry.title, chapter.title) ? 'downloaded' : entry.backlog === 'ignore' ? 'missing' : 'new';
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

    /** Disk sync pass: re-attach local chapter files to the database. Every
     *  entry's series folder is matched against its chapters by number and a
     *  matching file marks its chapter downloaded (a check that ran while the
     *  files lived elsewhere, a manual move, a restore…). Entries with no
     *  chapter rows at all (import whose sync failed, files pre-dating the
     *  database) get a source check first so there are rows to attach to;
     *  chapters that stay unattached are genuinely missing from disk. */
    async resyncLocalFiles(): Promise<{ attached: number; entries: number; checked: number }> {
        let attached = 0;
        let entries = 0;
        let checked = 0;
        for (const row of this._all<EntryRow>('SELECT * FROM library')) {
            const directory = this.seriesDirectory(row.id, row);
            if (!directory) {
                continue;
            }
            const byNumber = new Map<number, string>();
            for (const file of listChapterEntries(directory)) {
                const number = parseChapterNumber(file.replace(/\.cbz$/i, ''));
                if (number !== null && !byNumber.has(number)) {
                    byNumber.set(number, path.join(directory, file));
                }
            }
            if (byNumber.size === 0) {
                continue;
            }
            const count = this._get<{ n: number }>('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?', row.id);
            if (Number(count?.n ?? 0) === 0) {
                try {
                    await this.checkForNewChapters(row.id);
                    checked++;
                } catch {
                    // source unreachable: keep the disk-only pass — the
                    // display counts local files even without DB rows
                }
            }
            const matched = this.markDownloadedByNumber(row.id, byNumber);
            if (matched > 0) {
                attached += matched;
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
        for (const row of this._all<EntryRow>('SELECT * FROM library')) {
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
            const row = this._getEntryRow(id);
            if (!row || this._deadDirectory(row) === undefined) {
                continue;
            }
            // no FK on these two tables: clean the journal explicitly
            this.opts.db.db.prepare('DELETE FROM chapter_history WHERE entry_id = ?').run(id);
            this.opts.db.db.prepare('DELETE FROM entry_snapshots WHERE entry_id = ?').run(id);
            removed += Number(this.opts.db.db.prepare('DELETE FROM library WHERE id = ?').run(id).changes);
        }
        return removed;
    }

    /** The entry's last known folder when its files are gone from disk,
     *  undefined when the entry is still alive (or has nothing downloaded). */
    private _deadDirectory(row: EntryRow): string | null | undefined {
        const paths = this._all<{ path: string }>(
            `SELECT path FROM library_chapters
             WHERE entry_id = ? AND status = 'downloaded' AND path IS NOT NULL AND length(path) > 0`,
            row.id
        ).map(item => item.path);
        if (paths.length === 0) {
            return undefined;
        }
        const directory = this.seriesDirectory(row.id, row);
        const alive = (directory !== null && fs.existsSync(directory)) || paths.some(item => fs.existsSync(item));
        return alive ? undefined : directory;
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

    /** Monitored entries (scheduler checks, detection passes): visible and not paused. */
    async listFollowedEntries(): Promise<LibraryEntryDto[]> {
        const rows = this._all<EntryRow>('SELECT * FROM library WHERE hidden = 0 AND paused = 0 ORDER BY title COLLATE NOCASE ASC');
        return Promise.all(rows.map(row => this._entryToDto(row)));
    }

    /** Hide (or restore) an entry without touching its files: a hidden entry
     *  leaves the default library list and the scheduler. Restoring also
     *  refreshes the last-new-chapter date: a series watched again gets a
     *  fresh stale period instead of being paused right away. */
    setHidden(entryId: number, hidden: boolean): boolean {
        const sql = 'UPDATE library SET hidden = 1 WHERE id = ?';
        const restoreSql = 'UPDATE library SET hidden = 0, last_chapter_at = ? WHERE id = ?';
        const result = hidden ? this.opts.db.db.prepare(sql).run(entryId) : this.opts.db.db.prepare(restoreSql).run(new Date().toISOString(), entryId);
        return Number(result.changes) > 0;
    }

    /** Pause (or resume) monitoring: a paused entry stays visible — hiding is
     *  a manual, visual decision only. Resuming refreshes the last-new-chapter
     *  date (fresh stale period) and clears the stalled-probe back-off. */
    setPaused(entryId: number, paused: boolean): boolean {
        const sql = 'UPDATE library SET paused = 1 WHERE id = ?';
        const resumeSql = 'UPDATE library SET paused = 0, last_chapter_at = ?, staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?';
        const result = paused ? this.opts.db.db.prepare(sql).run(entryId) : this.opts.db.db.prepare(resumeSql).run(new Date().toISOString(), entryId);
        return Number(result.changes) > 0;
    }

    setAutoDownload(entryId: number, autoDownload: boolean): boolean {
        const result = this.opts.db.db.prepare('UPDATE library SET auto_download = ? WHERE id = ?').run(autoDownload ? 1 : 0, entryId);
        return Number(result.changes) > 0;
    }

    // ------------------------------------------------------------------
    // source health / failover
    // ------------------------------------------------------------------

    /** Download failures since the last failover probe (the probe resets the
     *  counter). Successes deliberately do not: a failing batch interleaved
     *  with successes must still trip the failover. */
    recordDownloadFailure(entryId: number): number {
        this.opts.db.db.prepare('UPDATE library SET download_failures = download_failures + 1 WHERE id = ?').run(entryId);
        return Number((this._get('SELECT download_failures AS n FROM library WHERE id = ?', entryId) as { n: number } | undefined)?.n ?? 0);
    }

    resetDownloadFailures(entryId: number): void {
        this.opts.db.db.prepare('UPDATE library SET download_failures = 0 WHERE id = ?').run(entryId);
    }

    /** Distinct entries of this source with a failed download job inside the
     *  window — several at once is a source outage, not per-series rot. */
    countRecentSourceFailures(sourceId: string, windowMs: number): number {
        const cutoff = new Date(Date.now() - windowMs).toISOString();
        const row = this._get<{ n: number }>(
            "SELECT COUNT(DISTINCT entry_id) AS n FROM download_jobs WHERE source_id = ? AND status = 'failed' AND entry_id IS NOT NULL AND updated_at > ?",
            sourceId,
            cutoff
        );
        return Number(row?.n ?? 0);
    }

    /** Entries of this source currently failing their checks (the counter
     *  resets on the first success). Several at once means the source itself
     *  is broken (API change, block) — not per-series rot. */
    countEntriesWithCheckFailures(sourceId: string): number {
        const row = this._get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM library WHERE source_id = ? AND hidden = 0 AND paused = 0 AND check_failures > 0',
            sourceId
        );
        return Number(row?.n ?? 0);
    }

    /** Note a failure on the source-outage record. `open` creates the row
     *  (INSERT OR IGNORE keeps the original started_at of the wave); a refresh
     *  only bumps an existing one. A closed record is reactivated on open: a
     *  quick reopen (flap) resumes the previous wave — escalation included —
     *  while a stale close starts a fresh clock. Arms the escalation stamp
     *  when the outage has lasted long enough — idempotent. Returns undefined
     *  when no outage row exists (refresh without a prior open). */
    noteSourceFailure(sourceId: string, open: boolean): SourceOutage | undefined {
        const now = new Date();
        const iso = now.toISOString();
        if (open) {
            this.opts.db.db
                .prepare('INSERT OR IGNORE INTO source_outages (source_id, started_at, last_seen_at, failures) VALUES (?, ?, ?, 0)')
                .run(sourceId, iso, iso);
        }
        const row = this._get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ?', sourceId);
        if (!row) {
            return undefined;
        }
        if (row.closed_at !== null) {
            const flap = Date.parse(row.closed_at) + OUTAGE_SILENCE_MS > now.getTime();
            const startedAt = flap ? row.started_at : iso;
            const escalatedAt = flap ? row.escalated_at : null;
            this.opts.db.db
                .prepare('UPDATE source_outages SET closed_at = NULL, started_at = ?, last_seen_at = ?, failures = 1, escalated_at = ? WHERE source_id = ?')
                .run(startedAt, iso, escalatedAt, sourceId);
            return toOutage({ source_id: sourceId, started_at: startedAt, last_seen_at: iso, failures: 1, escalated_at: escalatedAt, closed_at: null });
        }
        const escalatedAt = row.escalated_at ?? (Date.parse(row.started_at) + OUTAGE_ESCALATION_MS <= now.getTime() ? iso : null);
        this.opts.db.db
            .prepare('UPDATE source_outages SET last_seen_at = ?, failures = failures + 1, escalated_at = ? WHERE source_id = ?')
            .run(iso, escalatedAt, sourceId);
        return toOutage({ ...row, last_seen_at: iso, failures: row.failures + 1, escalated_at: escalatedAt });
    }

    getSourceOutage(sourceId: string): SourceOutage | undefined {
        const row = this._get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ? AND closed_at IS NULL', sourceId);
        return row ? toOutage(row) : undefined;
    }

    /** Every open outage (scheduler maintenance: silence-close, escalation). */
    listSourceOutages(): SourceOutage[] {
        return this._all<OutageRow>('SELECT * FROM source_outages WHERE closed_at IS NULL').map(toOutage);
    }

    /** Close an outage (source healed). The row is kept with a closed_at
     *  stamp: a quick reopen (flap) resumes the wave instead of restarting
     *  the escalation clock from scratch. Returns whether an open outage was
     *  closed. */
    closeSourceOutage(sourceId: string): boolean {
        return (
            Number(
                this.opts.db.db
                    .prepare('UPDATE source_outages SET closed_at = ? WHERE source_id = ? AND closed_at IS NULL')
                    .run(new Date().toISOString(), sourceId).changes
            ) > 0
        );
    }

    /** Arm the escalation stamp of an open outage whose started_at is old
     *  enough — the arming also happens on noteSourceFailure; this entry
     *  point covers outages whose jobs stopped retrying (silence) before the
     *  escalation delay elapsed. No-op otherwise. */
    armOutageEscalation(sourceId: string): SourceOutage | undefined {
        const row = this._get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ? AND closed_at IS NULL', sourceId);
        if (row && !row.escalated_at && Date.parse(row.started_at) + OUTAGE_ESCALATION_MS <= Date.now()) {
            this.opts.db.db.prepare('UPDATE source_outages SET escalated_at = ? WHERE source_id = ?').run(new Date().toISOString(), sourceId);
        }
        return this.getSourceOutage(sourceId);
    }

    /** Entries whose downloads keep failing (candidates for a source failover). */
    listDownloadFailing(minimum: number): Array<{ id: number; sourceId: string; title: string; downloadFailures: number }> {
        return this._all<{ id: number; source_id: string; title: string; download_failures: number }>(
            'SELECT id, source_id, title, download_failures FROM library WHERE hidden = 0 AND paused = 0 AND download_failures >= ? ORDER BY download_failures DESC',
            minimum
        ).map(row => ({ id: row.id, sourceId: row.source_id, title: row.title, downloadFailures: Number(row.download_failures) }));
    }

    /** Entries with no new chapter for more than `maxAgeDays` (stale-series
     *  auto-pause). Entries with pending check failures are skipped: an
     *  unreachable source must not be mistaken for an abandoned series. */
    listStaleEntries(maxAgeDays: number): Array<{ id: number; title: string; lastChapterAt: string }> {
        const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
        return this._all<{ id: number; title: string; last_chapter_at: string }>(
            `SELECT id, title, last_chapter_at FROM library
             WHERE hidden = 0 AND paused = 0 AND check_failures = 0 AND last_chapter_at IS NOT NULL AND last_chapter_at < ?`,
            cutoff
        ).map(row => ({ id: row.id, title: row.title, lastChapterAt: row.last_chapter_at }));
    }

    /** Entries whose series looks stalled relative to its own release rhythm
     *  (see the STALE_* constants): probe candidates for the stalled-source
     *  failover regime. Excludes entries with pending check failures — an
     *  unreachable source is the failure regime's job (maybeMigrate), not a
     *  stalled series. Most-stale first. */
    listStalledCandidates(): StalledCandidate[] {
        const now = new Date();
        const rows = this._all<{ id: number; source_id: string; title: string; last_chapter_at: string }>(
            `SELECT id, source_id, title, last_chapter_at FROM library
             WHERE hidden = 0 AND paused = 0 AND check_failures = 0 AND last_chapter_at IS NOT NULL
               AND migration_suggestion IS NULL
               AND (staleness_next_probe_at IS NULL OR staleness_next_probe_at <= ?)
             ORDER BY last_chapter_at ASC`,
            now.toISOString()
        );
        const candidates: StalledCandidate[] = [];
        for (const row of rows) {
            if (now.getTime() - Date.parse(row.last_chapter_at) < this._stalenessThresholdMs(row.id)) {
                continue;
            }
            const count = this._get<{ n: number }>('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?', row.id);
            candidates.push({ id: row.id, sourceId: row.source_id, title: row.title, chapterCount: Number(count?.n ?? 0) });
        }
        return candidates;
    }

    /** Record the outcome of a stalled-source probe: a hit (suggestion stored)
     *  resets the back-off; a miss (probable hiatus) spaces the next probe out
     *  exponentially — 7d, 14d, 28d… capped at STALE_BACKOFF_MAX_MS. */
    recordStalenessProbe(entryId: number, hit: boolean): void {
        if (hit) {
            this.opts.db.db.prepare('UPDATE library SET staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?').run(entryId);
            return;
        }
        const row = this._get<{ n: number }>('SELECT staleness_misses AS n FROM library WHERE id = ?', entryId);
        const misses = Number(row?.n ?? 0) + 1;
        const delay = Math.min(STALE_BACKOFF_BASE_MS * 2 ** (misses - 1), STALE_BACKOFF_MAX_MS);
        this.opts.db.db
            .prepare('UPDATE library SET staleness_misses = ?, staleness_next_probe_at = ? WHERE id = ?')
            .run(misses, new Date(Date.now() + delay).toISOString(), entryId);
    }

    /** Idle time after which a series looks stalled, learned from its own
     *  release rhythm (gaps between distinct discovery events); falls back to
     *  a fixed delay when too few events are on record. */
    private _stalenessThresholdMs(entryId: number): number {
        const events = this._all<{ discovered_at: string }>(
            'SELECT DISTINCT discovered_at FROM library_chapters WHERE entry_id = ? ORDER BY discovered_at DESC LIMIT ?',
            entryId,
            STALE_CADENCE_EVENTS
        )
            .map(row => Date.parse(row.discovered_at))
            .filter(timestamp => Number.isFinite(timestamp));
        const gaps: number[] = [];
        for (let index = 1; index < events.length; index++) {
            const gap = events[index - 1] - events[index];
            if (gap > 0) {
                gaps.push(gap);
            }
        }
        if (gaps.length < STALE_CADENCE_MIN_GAPS) {
            return STALE_FALLBACK_DAYS * DAY_MS;
        }
        const sorted = [...gaps].sort((a, b) => a - b);
        const medianGap = sorted[Math.floor(sorted.length / 2)];
        return Math.max(STALE_RHYTHM_FACTOR * medianGap, STALE_FLOOR_DAYS * DAY_MS);
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
        this.opts.db.db.prepare('UPDATE library SET migration_suggestion = ? WHERE id = ?').run(suggestion ? JSON.stringify(suggestion) : null, entryId);
    }

    /** Dismiss a suggestion AND remember the refusal, so the background
     *  detection does not re-suggest the same target on the next run. */
    dismissMigrationSuggestion(entryId: number, suggestion: MigrationTarget): void {
        this.opts.db.db
            .prepare('UPDATE library SET migration_suggestion = NULL, migration_dismissed = ? WHERE id = ?')
            .run(JSON.stringify(suggestion), entryId);
    }

    /** Replace the failover search aliases (manual editor or AniList merge).
     *  Returns what was actually kept, after normalization. */
    setAliases(entryId: number, aliases: ReadonlyArray<string>): string[] {
        const row = this._getEntryRow(entryId);
        if (!row) {
            throw new Error(`Library entry ${entryId} not found`);
        }
        const normalized = normalizeAliases(row.title, aliases);
        this.opts.db.db.prepare('UPDATE library SET aliases = ? WHERE id = ?').run(normalized.length > 0 ? JSON.stringify(normalized) : null, entryId);
        return normalized;
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

    /** After a migration rebuilt the chapter list on a new source, re-queue the
     *  chapters whose download failed on the old one (matched by chapter number,
     *  like the file carry-over) so the interrupted download resumes by itself. */
    requeueFailedAfterMigration(entryId: number, queue: DownloadQueue): number {
        const titles = (
            this.opts.db.db.prepare("SELECT chapter_title FROM download_jobs WHERE entry_id = ? AND status = 'failed'").all(entryId) as unknown as Array<{
                chapter_title: string;
            }>
        ).map(row => row.chapter_title);
        const numbers = new Set(
            titles.flatMap(title => {
                const number = parseChapterNumber(title);
                return number === null ? [] : [number];
            })
        );
        if (numbers.size === 0) {
            return 0;
        }
        const entry = this._getEntryRow(entryId);
        if (!entry) {
            return 0;
        }
        const chapters = this._all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId).filter(chapter => {
            const number = parseChapterNumber(chapter.title);
            return chapter.status !== 'downloaded' && number !== null && numbers.has(number);
        });
        // the consumed failures (and the still-queued old-source jobs, which
        // would keep failing pointlessly) are purged before enqueuing, so a
        // bulk "retry failed" cannot resurrect the dead source AND the fresh
        // jobs are not caught by the DELETE themselves
        this.opts.db.db.prepare("DELETE FROM download_jobs WHERE entry_id = ? AND status IN ('failed', 'queued')").run(entryId);
        return this._enqueueSelected(entry, chapters, queue, () =>
            this.markChaptersQueued(
                entryId,
                chapters.map(chapter => chapter.chapter_id)
            )
        );
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
    private async _rebuildChapters(
        entryId: number,
        target: MigrationTarget,
        source: SourceAdapter,
        downloadedByNumber: Map<number, ChapterRow>
    ): Promise<{ kept: number; total: number }> {
        const chapters = await source.getChapters({ id: target.mangaId, title: target.mangaTitle });
        const preferred = this.opts.getPreferredLanguages?.() || [];
        const now = new Date().toISOString();

        this.opts.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
        this.opts.db.db
            .prepare(
                `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                    migration_suggestion = NULL, migration_dismissed = NULL, check_failures = 0, last_checked_at = ?,
                    staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?`
            )
            .run(target.sourceId, source.label, target.mangaId, target.mangaTitle, target.url || null, now, entryId);

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
        const snapshot = this._get<{ id: number; data: string }>('SELECT * FROM entry_snapshots WHERE entry_id = ? ORDER BY id DESC LIMIT 1', entryId);
        if (!snapshot) {
            return false;
        }
        const data = JSON.parse(snapshot.data) as { entry: EntryRow; chapters: ChapterRow[] };
        this.opts.db.db
            .prepare(
                `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                    migration_suggestion = NULL, migration_dismissed = NULL, check_failures = 0 WHERE id = ?`
            )
            .run(data.entry.source_id, data.entry.source_label, data.entry.manga_id, data.entry.title, data.entry.url, entryId);
        this.opts.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
        const insert = this.opts.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
        for (const chapter of data.chapters) {
            insert.run(
                entryId,
                chapter.chapter_id,
                chapter.title,
                chapter.language,
                chapter.status,
                chapter.path,
                chapter.discovered_at,
                chapter.downloaded_at
            );
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
        // a hanging connector must not stall the scheduler's run forever
        const chapters = await withTimeout(source.getChapters({ id: row.manga_id, title: row.title }), 2 * 60 * 1000, `getChapters(${row.title})`);
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
        if (fresh.length > 0) {
            // a new chapter just arrived: refresh the date that arms the
            // stale-series auto-unfollow and clear the stalled-probe
            // back-off — the series is fresh again
            this.opts.db.db
                .prepare('UPDATE library SET last_checked_at = ?, last_chapter_at = ?, staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?')
                .run(now, now, entryId);
        } else {
            this.opts.db.db.prepare('UPDATE library SET last_checked_at = ? WHERE id = ?').run(now, entryId);
        }
        return { fresh, usableSeen };
    }

    /** Enqueue every not-yet-downloaded chapter ('new' status plus failed
     *  downloads worth retrying) into the download queue. */
    enqueueNewChapters(entryId: number, queue: DownloadQueue): number {
        const entry = this._getEntryRow(entryId);
        if (!entry) {
            return 0;
        }
        const chapters = this._all<ChapterRow>(
            "SELECT * FROM library_chapters WHERE entry_id = ? AND status IN ('new', 'failed') ORDER BY discovered_at ASC",
            entryId
        );
        const markQueued = () => {
            this.opts.db.db
                .prepare("UPDATE library_chapters SET status = ?, prev_status = status WHERE entry_id = ? AND status IN ('new', 'failed')")
                .run('queued', entryId);
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
            entryId,
            ...chapterIds
        );
        const markQueued = () => {
            this.opts.db.db
                .prepare(
                    `UPDATE library_chapters SET status = 'queued', prev_status = status WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status = 'new'`
                )
                .run(entryId, ...chapterIds);
        };
        return this._enqueueSelected(entry, chapters, queue, markQueued);
    }

    /** Find the library entry tracking a given manga on a source (null when untracked). */
    findEntryByManga(sourceId: string, mangaId: string): EntryRow | null {
        return this._get<EntryRow>('SELECT * FROM library WHERE source_id = ? AND manga_id = ?', sourceId, mangaId) ?? null;
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
        return this._all<EntryRow>('SELECT * FROM library').find(row => normalizeTitle(row.title) === needle) ?? null;
    }

    /** Attach local files to an already-tracked entry's chapters by number
     *  (re-import of a series tracked elsewhere): each match not yet
     *  'downloaded' is marked with its file path. Returns the matched count. */
    markDownloadedByNumber(entryId: number, localByNumber: Map<number, string>): number {
        const byNumber = new Map<number, { chapterId: string; status: string }>();
        for (const chapter of this.listChapters(entryId)) {
            const number = parseChapterNumber(chapter.title);
            if (number !== null && !byNumber.has(number)) {
                byNumber.set(number, { chapterId: chapter.chapterId, status: chapter.status });
            }
        }
        let matched = 0;
        for (const [number, localPath] of localByNumber) {
            const chapter = byNumber.get(number);
            if (!chapter) {
                continue;
            }
            matched++;
            if (chapter.status !== 'downloaded') {
                this.markChapter(entryId, chapter.chapterId, 'downloaded', localPath, 'import');
            }
        }
        return matched;
    }

    /** Flag tracked chapters as queued after an ad-hoc enqueue (covers failed retries
     *  and the backlog marked 'missing' by a monitor-only follow). */
    markChaptersQueued(entryId: number, chapterIds: string[]): number {
        if (chapterIds.length === 0) {
            return 0;
        }
        const placeholders = chapterIds.map(() => '?').join(', ');
        const result = this.opts.db.db
            .prepare(
                `UPDATE library_chapters SET status = 'queued', prev_status = status WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status IN ('new', 'missing', 'failed')`
            )
            .run(entryId, ...chapterIds);
        return Number(result.changes);
    }

    /** A cancelled download reverts a still-queued chapter to its pre-queue
     *  status (e.g. 'missing' for a monitor-only backlog) so it does not
     *  surface as 'new'; rows that moved on in the meantime are left alone. */
    revertCancelledChapter(entryId: number, chapterId: string): void {
        this.opts.db.db
            .prepare(
                `UPDATE library_chapters SET status = COALESCE(prev_status, 'new'), prev_status = NULL
                 WHERE entry_id = ? AND chapter_id = ? AND status = 'queued'`
            )
            .run(entryId, chapterId);
    }

    /** Bulk variant of revertCancelledChapter for cleared queues: restores every
     *  listed chapter still stuck at 'queued' back to its pre-queue status. */
    revertClearedChapters(pairs: Array<{ entryId: number; chapterId: string }>): void {
        const update = this.opts.db.db.prepare(
            `UPDATE library_chapters SET status = COALESCE(prev_status, 'new'), prev_status = NULL
             WHERE entry_id = ? AND chapter_id = ? AND status = 'queued'`
        );
        for (const { entryId, chapterId } of pairs) {
            update.run(entryId, chapterId);
        }
    }

    /** Called by the download queue / import / failover when a chapter changes. */
    markChapter(entryId: number, chapterId: string, status: 'downloaded' | 'failed' | 'new', filePath?: string, origin = 'download'): void {
        const previous = this._get<{ title: string; status: string; path: string | null }>(
            'SELECT title, status, path FROM library_chapters WHERE entry_id = ? AND chapter_id = ?',
            entryId,
            chapterId
        );
        this.opts.db.db
            .prepare('UPDATE library_chapters SET status = ?, path = ?, downloaded_at = ? WHERE entry_id = ? AND chapter_id = ?')
            .run(status, filePath || null, status === 'downloaded' ? new Date().toISOString() : null, entryId, chapterId);
        if (previous && (previous.status !== status || previous.path !== (filePath || null))) {
            this._recordChapterHistory(entryId, chapterId, previous.title, origin, previous.status, previous.path, status, filePath || null);
        }
    }

    /** Full change history of an entry's chapters (newest first). */
    chapterHistory(entryId: number, chapterId?: string): Array<Record<string, unknown>> {
        if (chapterId) {
            return this._all<Record<string, unknown>>(
                'SELECT * FROM chapter_history WHERE entry_id = ? AND chapter_id = ? ORDER BY id DESC',
                entryId,
                chapterId
            );
        }
        return this._all<Record<string, unknown>>('SELECT * FROM chapter_history WHERE entry_id = ? ORDER BY id DESC LIMIT 200', entryId);
    }

    /** Restore a chapter to its previous downloaded file (latest history entry with a previous path). */
    rollbackChapter(entryId: number, chapterId: string): boolean {
        const last = this._get<{ old_path: string }>(
            `SELECT old_path FROM chapter_history
             WHERE entry_id = ? AND chapter_id = ? AND old_status = 'downloaded' AND old_path IS NOT NULL
             ORDER BY id DESC LIMIT 1`,
            entryId,
            chapterId
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

    private _toQueueItem(
        entry: EntryRow,
        chapter: ChapterRow
    ): { sourceId: string; mangaId: string; mangaTitle: string; chapterId: string; chapterTitle: string; entryId: number } {
        return {
            sourceId: entry.source_id,
            mangaId: entry.manga_id,
            mangaTitle: entry.title,
            chapterId: chapter.chapter_id,
            chapterTitle: chapter.title,
            entryId: entry.id
        };
    }

    private _recordChapterHistory(
        entryId: number,
        chapterId: string,
        title: string,
        event: string,
        oldStatus: string | null,
        oldPath: string | null,
        newStatus: string,
        newPath: string | null
    ): void {
        this.opts.db.db
            .prepare(
                `INSERT INTO chapter_history (entry_id, chapter_id, title, event, old_status, old_path, new_status, new_path, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(entryId, chapterId, title, event, oldStatus, oldPath, newStatus, newPath, new Date().toISOString());
    }

    private _snapshotEntry(entryId: number, reason: string): void {
        const entry = this._getEntryRow(entryId);
        if (!entry) {
            return;
        }
        const chapters = this._all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId);
        this.opts.db.db
            .prepare('INSERT INTO entry_snapshots (entry_id, reason, data, at) VALUES (?, ?, ?, ?)')
            .run(entryId, reason, JSON.stringify({ entry, chapters }), new Date().toISOString());
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
            CREATE TABLE IF NOT EXISTS source_outages (
                source_id    TEXT PRIMARY KEY,
                started_at   TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                failures     INTEGER NOT NULL DEFAULT 0,
                escalated_at TEXT,
                closed_at    TEXT
            );
        `);
        // databases created before the soft-close redesign: add the closed_at stamp
        const outageColumns = this.opts.db.db.prepare('PRAGMA table_info(source_outages)').all() as Array<{ name: string }>;
        this._addColumn('source_outages', outageColumns, 'closed_at', 'closed_at TEXT');

        // existing databases: add columns when missing
        const columns = this.opts.db.db.prepare('PRAGMA table_info(library)').all() as Array<{ name: string }>;
        this._addColumn('library', columns, 'thumbnail', 'thumbnail TEXT');
        this._addColumn('library', columns, 'check_failures', 'check_failures INTEGER NOT NULL DEFAULT 0');
        this._addColumn('library', columns, 'migration_suggestion', 'migration_suggestion TEXT');
        this._addColumn('library', columns, 'migration_dismissed', 'migration_dismissed TEXT');
        this._addColumn('library', columns, 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
        this._addColumn('library', columns, 'download_failures', 'download_failures INTEGER NOT NULL DEFAULT 0');
        this._addColumn('library', columns, 'last_chapter_at', 'last_chapter_at TEXT');
        this._addColumn('library', columns, 'staleness_misses', 'staleness_misses INTEGER NOT NULL DEFAULT 0');
        this._addColumn('library', columns, 'staleness_next_probe_at', 'staleness_next_probe_at TEXT');
        this._addColumn('library', columns, 'paused', 'paused INTEGER NOT NULL DEFAULT 0');
        this._addColumn('library', columns, 'aliases', 'aliases TEXT');
        // unknown last-new-chapter date (existing databases, imports, or rows
        // created between the ALTER and a crash): start from today so the
        // auto-unfollow cannot fire right on startup — runs on every boot, a
        // no-op once every row carries a date
        this.opts.db.db.prepare('UPDATE library SET last_chapter_at = ? WHERE last_chapter_at IS NULL').run(new Date().toISOString());
        const chapterColumns = this.opts.db.db.prepare('PRAGMA table_info(library_chapters)').all() as Array<{ name: string }>;
        this._addColumn('library_chapters', chapterColumns, 'prev_status', 'prev_status TEXT');
    }

    /** ALTER TABLE helper: adds `ddl` (must reference `name`) to `table` when the column is missing. */
    private _addColumn(table: string, columns: Array<{ name: string }>, name: string, ddl: string): void {
        if (!columns.some(column => column.name === name)) {
            this.opts.db.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
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
        ) ?? { total: null, downloaded: null, fresh: null };
        const snapshot = this._get<{ n: number }>('SELECT COUNT(*) AS n FROM entry_snapshots WHERE entry_id = ?', row.id) ?? { n: 0 };
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
            const directory = this.seriesDirectory(row.id, row);
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
