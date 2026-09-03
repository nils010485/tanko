/**
 * Chapter operations: source checks that diff the listing against the store,
 * enqueue helpers, status transitions journaled in chapter_history (rollback),
 * and the local-file attachment (imports, disk resyncs).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LibraryChapterDto } from '@tanko/shared';
import type { DownloadQueue } from '../downloader/queue.js';
// runtime constant only — the queue module does not import this file, so no
// runtime cycle is created
import { AUTO_RETRY_MAX } from '../downloader/queue.js';
import { parseChapterNumber } from '../import/scanner.js';
import { chapterAllowed } from '../languages.js';
import { withTimeout } from '../util/timeout.js';
import type { StoreContext } from './context.js';
import { getEntryRow } from './context.js';
import type { ChapterRow, EntryRow } from './rows.js';
import { SQL_INSERT_CHAPTER_FULL, SQL_INSERT_NEW_CHAPTER } from './rows.js';

/** Databases whose download_jobs table has been seen (the table is created by
 *  DownloadQueue, possibly after the store — cached once found). */
const jobsTableSeen = new WeakSet<object>();

function jobsTableExists(ctx: StoreContext): boolean {
    if (jobsTableSeen.has(ctx.db)) {
        return true;
    }
    const seen = ctx.db.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'download_jobs'").get() !== undefined;
    if (seen) {
        jobsTableSeen.add(ctx.db);
    }
    return seen;
}

/**
 * Fetch the current chapter list from the source and store any chapter
 * that is not known yet (status 'new'). Returns the new chapters.
 */
export async function checkForNewChapters(ctx: StoreContext, entryId: number): Promise<{ fresh: ChapterRow[]; usableSeen: number }> {
    const row = getEntryRow(ctx, entryId);
    if (!row) {
        throw new Error(`Library entry ${entryId} not found`);
    }
    const source = await ctx.registry.get(row.source_id);
    if (!source) {
        throw new Error(`Source "${row.source_id}" not found`);
    }
    // a hanging connector must not stall the scheduler's run forever
    const preferred = ctx.getPreferredLanguages?.() || [];
    const chapters = await withTimeout(
        source.getChapters({ id: row.manga_id, title: row.title }, { languages: preferred }),
        2 * 60 * 1000,
        `getChapters(${row.title})`
    );
    const now = new Date().toISOString();
    const insert = ctx.db.db.prepare(SQL_INSERT_NEW_CHAPTER);
    const fresh: ChapterRow[] = [];
    // local-only rows (files the source never listed) whose number the
    // source now carries are absorbed into the real chapter: same file,
    // real chapter id, no duplicate row
    const known = new Set(
        ctx.q.all<{ chapter_id: string }>('SELECT chapter_id FROM library_chapters WHERE entry_id = ?', entryId).map(item => item.chapter_id)
    );
    const ghosts = new Map<number, ChapterRow>();
    for (const ghost of ctx.q.all<ChapterRow>("SELECT * FROM library_chapters WHERE entry_id = ? AND chapter_id LIKE 'local:%'", entryId)) {
        const number = parseChapterNumber(ghost.title);
        if (number !== null && !ghosts.has(number)) {
            ghosts.set(number, ghost);
        }
    }
    const absorb = ctx.db.db.prepare('UPDATE library_chapters SET chapter_id = ?, title = ?, language = ? WHERE entry_id = ? AND id = ?');
    let usableSeen = 0;
    for (const chapter of chapters) {
        if (!chapterAllowed(chapter.language, preferred)) {
            continue;
        }
        usableSeen++;
        const number = parseChapterNumber(chapter.title);
        const ghost = number !== null && !known.has(chapter.id) ? ghosts.get(number) : undefined;
        if (ghost && number !== null) {
            absorb.run(chapter.id, chapter.title, chapter.language || null, entryId, ghost.id);
            ghosts.delete(number);
            continue;
        }
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
    // Reconcile failed chapters against the listing: a chapter the source
    // no longer lists is 'lost' (slow revalidation stops — the download
    // can never succeed), and a 'lost' chapter listed again goes back to
    // 'failed' (revalidation resumes at its cooldown step). Guarded by
    // usableSeen > 0: an empty or language-stripped listing (takedown)
    // must never mass-mark chapters lost. The RAW listing (preferred
    // languages included) keeps a language-preference change from losing
    // chapters either.
    if (usableSeen > 0) {
        const listed = JSON.stringify(chapters.map(chapter => chapter.id));
        ctx.db.db
            .prepare(
                `UPDATE library_chapters SET status = 'lost'
                 WHERE entry_id = ? AND status = 'failed'
                   AND chapter_id NOT LIKE 'local:%'
                   AND chapter_id NOT IN (SELECT value FROM json_each(?))`
            )
            .run(entryId, listed);
        ctx.db.db
            .prepare(
                `UPDATE library_chapters SET status = 'failed'
                 WHERE entry_id = ? AND status = 'lost'
                   AND chapter_id IN (SELECT value FROM json_each(?))`
            )
            .run(entryId, listed);
    }
    if (fresh.length > 0) {
        // a new chapter just arrived: refresh the date that arms the
        // stale-series auto-unfollow and clear the stalled-probe
        // back-off — the series is fresh again
        ctx.db.db
            .prepare('UPDATE library SET last_checked_at = ?, last_chapter_at = ?, staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?')
            .run(now, now, entryId);
    } else {
        ctx.db.db.prepare('UPDATE library SET last_checked_at = ? WHERE id = ?').run(now, entryId);
    }
    return { fresh, usableSeen };
}

/** Enqueue every not-yet-downloaded chapter ('new' status plus failed
 *  downloads worth retrying) into the download queue. With `includeMissing`,
 *  chapters that predate the follow ('missing') are grabbed too. */
export function enqueueNewChapters(ctx: StoreContext, entryId: number, queue: DownloadQueue, includeMissing = false): number {
    const entry = getEntryRow(ctx, entryId);
    if (!entry) {
        return 0;
    }
    const statuses = includeMissing ? "('new', 'missing', 'failed')" : "('new', 'failed')";
    const chapters = ctx.q.all<ChapterRow>(`SELECT * FROM library_chapters WHERE entry_id = ? AND status IN ${statuses} ORDER BY discovered_at ASC`, entryId);
    const markQueued = () => {
        ctx.db.db.prepare(`UPDATE library_chapters SET status = ?, prev_status = status WHERE entry_id = ? AND status IN ${statuses}`).run('queued', entryId);
    };
    return enqueueSelected(entry, chapters, queue, markQueued);
}

/** Enqueue a specific set of chapters (used by the scheduler for the fresh diff only). */
export function enqueueChapters(ctx: StoreContext, entryId: number, chapterIds: string[], queue: DownloadQueue): number {
    const entry = getEntryRow(ctx, entryId);
    if (!entry || chapterIds.length === 0) {
        return 0;
    }
    const placeholders = chapterIds.map(() => '?').join(', ');
    const chapters = ctx.q.all<ChapterRow>(
        `SELECT * FROM library_chapters WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status = 'new'`,
        entryId,
        ...chapterIds
    );
    const markQueued = () => {
        ctx.db.db
            .prepare(
                `UPDATE library_chapters SET status = 'queued', prev_status = status WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status = 'new'`
            )
            .run(entryId, ...chapterIds);
    };
    return enqueueSelected(entry, chapters, queue, markQueued);
}

/** Attach local files to an entry's chapters by number, and register the
 *  files the source never listed as local-only chapter rows ('local:<n>'):
 *  a starved or oddly numbered source must not hide chapters that sit on
 *  disk — they appear in the chapter list and the counts, and a later
 *  check absorbs them into the real source chapter. */
export function registerLocalChapters(ctx: StoreContext, entryId: number, localByNumber: Map<number, string>): { attached: number; registered: number } {
    const attached = markDownloadedByNumber(ctx, entryId, localByNumber);
    const known = new Set<number>();
    for (const chapter of listChapters(ctx, entryId)) {
        const number = parseChapterNumber(chapter.title);
        if (number !== null) {
            known.add(number);
        }
    }
    const now = new Date().toISOString();
    const insert = ctx.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
    let registered = 0;
    for (const [number, localPath] of localByNumber) {
        if (known.has(number)) {
            continue;
        }
        const result = insert.run(entryId, `local:${number}`, path.basename(localPath).replace(/\.cbz$/i, ''), null, 'downloaded', localPath, now, now);
        registered += Number(result.changes);
        known.add(number);
    }
    return { attached, registered };
}

/** Attach local files to an already-tracked entry's chapters by number
 *  (re-import of a series tracked elsewhere): each match not yet
 *  'downloaded' is marked with its file path. Returns the matched count. */
export function markDownloadedByNumber(ctx: StoreContext, entryId: number, localByNumber: Map<number, string>): number {
    const byNumber = new Map<number, { chapterId: string; status: string }>();
    for (const chapter of listChapters(ctx, entryId)) {
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
            markChapter(ctx, entryId, chapter.chapterId, 'downloaded', localPath, 'import');
        }
    }
    return matched;
}

/** Flag tracked chapters as queued after an ad-hoc enqueue (covers failed retries
 *  and the backlog marked 'missing' by a monitor-only follow). */
export function markChaptersQueued(ctx: StoreContext, entryId: number, chapterIds: string[]): number {
    if (chapterIds.length === 0) {
        return 0;
    }
    const placeholders = chapterIds.map(() => '?').join(', ');
    const result = ctx.db.db
        .prepare(
            `UPDATE library_chapters SET status = 'queued', prev_status = status WHERE entry_id = ? AND chapter_id IN (${placeholders}) AND status IN ('new', 'missing', 'failed', 'lost')`
        )
        .run(entryId, ...chapterIds);
    return Number(result.changes);
}

/** A cancelled download reverts a still-queued chapter to its pre-queue
 *  status (e.g. 'missing' for a monitor-only backlog) so it does not
 *  surface as 'new'; rows that moved on in the meantime are left alone. */
export function revertCancelledChapter(ctx: StoreContext, entryId: number, chapterId: string): void {
    ctx.db.db
        .prepare(
            `UPDATE library_chapters SET status = COALESCE(prev_status, 'new'), prev_status = NULL
             WHERE entry_id = ? AND chapter_id = ? AND status = 'queued'`
        )
        .run(entryId, chapterId);
}

/** Bulk variant of revertCancelledChapter for cleared queues: restores every
 *  listed chapter still stuck at 'queued' back to its pre-queue status. */
export function revertClearedChapters(ctx: StoreContext, pairs: Array<{ entryId: number; chapterId: string }>): void {
    const update = ctx.db.db.prepare(
        `UPDATE library_chapters SET status = COALESCE(prev_status, 'new'), prev_status = NULL
         WHERE entry_id = ? AND chapter_id = ? AND status = 'queued'`
    );
    for (const { entryId, chapterId } of pairs) {
        update.run(entryId, chapterId);
    }
}

/** Called by the download queue / import / failover when a chapter changes.
 *  A 'failed' report never overwrites 'lost': an attempt already in
 *  flight when the chapter was delisted must not resurrect it (the sweeps
 *  stop requeueing lost chapters; only a manual retry or the source
 *  listing it again moves it). */
export function markChapter(
    ctx: StoreContext,
    entryId: number,
    chapterId: string,
    status: 'downloaded' | 'failed' | 'new',
    filePath?: string,
    origin = 'download'
): void {
    const previous = ctx.q.get<{ title: string; status: string; path: string | null }>(
        'SELECT title, status, path FROM library_chapters WHERE entry_id = ? AND chapter_id = ?',
        entryId,
        chapterId
    );
    ctx.db.db
        .prepare(
            "UPDATE library_chapters SET status = ?, path = ?, downloaded_at = ? WHERE entry_id = ? AND chapter_id = ? AND (status <> 'lost' OR ? <> 'failed')"
        )
        .run(status, filePath || null, status === 'downloaded' ? new Date().toISOString() : null, entryId, chapterId, status);
    // history records actual transitions only: the lost-guard above can
    // leave the row untouched, so compare against a fresh read
    const updated = ctx.q.get<{ status: string; path: string | null }>(
        'SELECT status, path FROM library_chapters WHERE entry_id = ? AND chapter_id = ?',
        entryId,
        chapterId
    );
    if (previous && updated && (updated.status !== previous.status || updated.path !== previous.path)) {
        recordChapterHistory(ctx, entryId, chapterId, previous.title, origin, previous.status, previous.path, updated.status, updated.path);
    }
}

/** Full change history of an entry's chapters (newest first). */
export function chapterHistory(ctx: StoreContext, entryId: number, chapterId?: string): Array<Record<string, unknown>> {
    if (chapterId) {
        return ctx.q.all<Record<string, unknown>>('SELECT * FROM chapter_history WHERE entry_id = ? AND chapter_id = ? ORDER BY id DESC', entryId, chapterId);
    }
    return ctx.q.all<Record<string, unknown>>('SELECT * FROM chapter_history WHERE entry_id = ? ORDER BY id DESC LIMIT 200', entryId);
}

/** Restore a chapter to its previous downloaded file (latest history entry with a previous path). */
export function rollbackChapter(ctx: StoreContext, entryId: number, chapterId: string): boolean {
    const last = ctx.q.get<{ old_path: string }>(
        `SELECT old_path FROM chapter_history
         WHERE entry_id = ? AND chapter_id = ? AND old_status = 'downloaded' AND old_path IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        entryId,
        chapterId
    );
    if (!last?.old_path || !fs.existsSync(last.old_path)) {
        return false;
    }
    markChapter(ctx, entryId, chapterId, 'downloaded', last.old_path, 'rollback');
    return true;
}

export function listChapters(ctx: StoreContext, entryId: number): LibraryChapterDto[] {
    // the download-jobs join is optional: the store can run standalone
    // (tests, queue-less deployments) before the queue creates its table
    const jobsJoin = jobsTableExists(ctx)
        ? `,
                EXISTS(SELECT 1 FROM download_jobs j
                       WHERE j.entry_id = c.entry_id AND j.chapter_id = c.chapter_id
                         AND j.status = 'failed' AND j.auto_retries >= ${AUTO_RETRY_MAX}
                         AND EXISTS(SELECT 1 FROM library l WHERE l.id = j.entry_id AND l.source_id = j.source_id AND l.hidden = 0 AND l.paused = 0)) AS retry_exhausted`
        : ', 0 AS retry_exhausted';
    const rows = ctx.q.all<ChapterRow & { history_count: number; retry_exhausted: number }>(
        `SELECT c.*,
                (SELECT COUNT(*) FROM chapter_history h WHERE h.entry_id = c.entry_id AND h.chapter_id = c.chapter_id) AS history_count${jobsJoin}
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
        localOnly: row.chapter_id.startsWith('local:') || undefined,
        discoveredAt: row.discovered_at,
        downloadedAt: row.downloaded_at || undefined,
        historyCount: Number(row.history_count || 0),
        retryExhausted: row.retry_exhausted === 1 || undefined
    }));
}

/** Queue the selected chapters and flip them to 'queued'; returns the queued count. */
export function enqueueSelected(entry: EntryRow, chapters: ChapterRow[], queue: DownloadQueue, markQueued: () => void): number {
    // the empty guard matters: queue.enqueue([]) would still trigger a scheduler tick
    if (chapters.length === 0) {
        return 0;
    }
    queue.enqueue(chapters.map(chapter => toQueueItem(entry, chapter)));
    markQueued();
    return chapters.length;
}

function toQueueItem(
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

function recordChapterHistory(
    ctx: StoreContext,
    entryId: number,
    chapterId: string,
    title: string,
    event: string,
    oldStatus: string | null,
    oldPath: string | null,
    newStatus: string,
    newPath: string | null
): void {
    ctx.db.db
        .prepare(
            `INSERT INTO chapter_history (entry_id, chapter_id, title, event, old_status, old_path, new_status, new_path, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(entryId, chapterId, title, event, oldStatus, oldPath, newStatus, newPath, new Date().toISOString());
}
