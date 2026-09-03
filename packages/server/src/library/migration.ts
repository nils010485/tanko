/**
 * Source migrations: move an entry to another source while carrying the
 * downloaded files over (matched by chapter number), keep a full snapshot
 * for the undo, re-queue the chapters that failed on the old source, and
 * store/dismiss the failover's migration suggestions.
 */
import path from 'node:path';
import type { SourceAdapter } from '@tanko/core';
import { listChapterEntries } from '../downloader/paths.js';
import type { DownloadQueue } from '../downloader/queue.js';
import { parseChapterNumber } from '../import/scanner.js';
import { chapterAllowed } from '../languages.js';
import { withTimeout } from '../util/timeout.js';
import { enqueueSelected, markChaptersQueued } from './chapters.js';
import type { StoreContext } from './context.js';
import { getEntryRow, isDownloaded, seriesDirectory } from './context.js';
import type { ChapterRow, EntryRow, MigrationTarget } from './rows.js';
import { SQL_INSERT_CHAPTER_FULL } from './rows.js';

export function setMigrationSuggestion(ctx: StoreContext, entryId: number, suggestion: MigrationTarget | null): void {
    ctx.db.db.prepare('UPDATE library SET migration_suggestion = ? WHERE id = ?').run(suggestion ? JSON.stringify(suggestion) : null, entryId);
}

/** Dismiss a suggestion AND remember the refusal, so the background
 *  detection does not re-suggest the same target on the next run. */
export function dismissMigrationSuggestion(ctx: StoreContext, entryId: number, suggestion: MigrationTarget): void {
    ctx.db.db.prepare('UPDATE library SET migration_suggestion = NULL, migration_dismissed = ? WHERE id = ?').run(JSON.stringify(suggestion), entryId);
}

/**
 * Move an entry to another source: snapshot the current state, then rebuild
 * the chapter list from the new source. Downloaded chapters keep their
 * local file, matched by chapter number.
 */
export async function migrateEntry(ctx: StoreContext, entryId: number, target: MigrationTarget): Promise<{ kept: number; total: number }> {
    const row = getEntryRow(ctx, entryId);
    if (!row) {
        throw new Error(`Library entry ${entryId} not found`);
    }
    const source = await ctx.registry.get(target.sourceId);
    if (!source) {
        throw new Error(`Source "${target.sourceId}" introuvable`);
    }

    snapshotEntry(ctx, entryId, 'failover');
    const downloaded = downloadedByNumber(ctx, entryId);
    // local files matter as much as DB rows: an entry imported from a
    // starved source (a handful of chapters listed) has barely any
    // 'downloaded' row to carry — rebuilding on a richer source must not
    // mark those files missing just because the old source ignored them
    const disk = diskByNumber(seriesDirectory(ctx, entryId));
    const result = await rebuildChapters(ctx, entryId, target, source, downloaded, disk);
    // the consumed linked provenance is spent: the entry now lives there, and
    // the migration snapshot already offers the way back
    ctx.db.db.prepare('DELETE FROM library_alternatives WHERE entry_id = ? AND source_id = ? AND manga_id = ?').run(entryId, target.sourceId, target.mangaId);
    return result;
}

/** After a migration rebuilt the chapter list on a new source, re-queue the
 *  chapters whose download failed on the old one (matched by chapter number,
 *  like the file carry-over) so the interrupted download resumes by itself. */
export function requeueFailedAfterMigration(ctx: StoreContext, entryId: number, queue: DownloadQueue): number {
    const titles = (
        ctx.db.db.prepare("SELECT chapter_title FROM download_jobs WHERE entry_id = ? AND status = 'failed'").all(entryId) as unknown as Array<{
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
    const entry = getEntryRow(ctx, entryId);
    if (!entry) {
        return 0;
    }
    const failed = ctx.q.all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId).filter(chapter => {
        const number = parseChapterNumber(chapter.title);
        return chapter.status !== 'downloaded' && number !== null && numbers.has(number);
    });
    // the consumed failures (and the still-queued old-source jobs, which
    // would keep failing pointlessly) are purged before enqueuing, so a
    // bulk "retry failed" cannot resurrect the dead source AND the fresh
    // jobs are not caught by the DELETE themselves
    ctx.db.db.prepare("DELETE FROM download_jobs WHERE entry_id = ? AND status IN ('failed', 'queued')").run(entryId);
    return enqueueSelected(entry, failed, queue, () =>
        markChaptersQueued(
            ctx,
            entryId,
            failed.map(chapter => chapter.chapter_id)
        )
    );
}

/** Downloaded chapters of an entry keyed by chapter number (first occurrence wins). */
function downloadedByNumber(ctx: StoreContext, entryId: number): Map<number, ChapterRow> {
    const oldChapters = ctx.q.all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId);
    const byNumber = new Map<number, ChapterRow>();
    for (const chapter of oldChapters) {
        if (chapter.status !== 'downloaded' || !chapter.path) {
            continue;
        }
        const number = parseChapterNumber(chapter.title);
        if (number !== null && !byNumber.has(number)) {
            byNumber.set(number, chapter);
        }
    }
    return byNumber;
}

/** Local chapter files of an entry's series folder, keyed by parsed
 *  chapter number (first occurrence wins). Empty when the folder is
 *  missing or holds nothing usable. */
export function diskByNumber(directory: string | null): Map<number, string> {
    const byNumber = new Map<number, string>();
    if (!directory) {
        return byNumber;
    }
    for (const file of listChapterEntries(directory)) {
        const number = parseChapterNumber(file.replace(/\.cbz$/i, ''));
        if (number !== null && !byNumber.has(number)) {
            byNumber.set(number, path.join(directory, file));
        }
    }
    return byNumber;
}

/** Replace the entry's chapter list from the new source, carrying downloaded files over. */
async function rebuildChapters(
    ctx: StoreContext,
    entryId: number,
    target: MigrationTarget,
    source: SourceAdapter,
    downloadedByNumber: Map<number, ChapterRow>,
    diskByNumber: Map<number, string>
): Promise<{ kept: number; total: number }> {
    // the validation probe is already bounded — the commit re-fetch must be
    // too, or a hanging connector strands the entry in `probing` forever
    const preferred = ctx.getPreferredLanguages?.() || [];
    const chapters = await withTimeout(
        source.getChapters({ id: target.mangaId, title: target.mangaTitle }, { languages: preferred }),
        2 * 60 * 1000,
        `getChapters(${target.mangaTitle})`
    );
    const now = new Date().toISOString();
    // the entry's canonical folder is untouched by the migration: downloads
    // and disk checks keep using it under the new source's title
    const entryDirectory = ctx.q.get<{ directory: string | null }>('SELECT directory FROM library WHERE id = ?', entryId)?.directory ?? null;

    ctx.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
    ctx.db.db
        .prepare(
            `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                migration_suggestion = NULL, migration_dismissed = NULL, check_failures = 0, last_checked_at = ?,
                staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?`
        )
        .run(target.sourceId, source.label, target.mangaId, target.mangaTitle, target.url || null, now, entryId);

    const insert = ctx.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
    let kept = 0;
    let total = 0;
    const listedNumbers = new Set<number>();
    for (const chapter of chapters) {
        if (!chapterAllowed(chapter.language, preferred)) {
            continue;
        }
        total++;
        const number = parseChapterNumber(chapter.title);
        if (number !== null) {
            listedNumbers.add(number);
        }
        const fromDb = number !== null ? downloadedByNumber.get(number) : undefined;
        const fromDisk = number !== null ? diskByNumber.get(number) : undefined;
        if (fromDb) {
            insert.run(entryId, chapter.id, chapter.title, chapter.language || null, 'downloaded', fromDb.path, now, fromDb.downloaded_at);
            kept++;
        } else if (fromDisk) {
            insert.run(entryId, chapter.id, chapter.title, chapter.language || null, 'downloaded', fromDisk, now, now);
            kept++;
        } else {
            const status = isDownloaded(ctx, source.label, target.mangaTitle, chapter.title, { id: entryId, directory: entryDirectory }) ? 'downloaded' : 'new';
            insert.run(entryId, chapter.id, chapter.title, chapter.language || null, status, null, now, null);
        }
    }
    // files with no counterpart on the new source stay visible as
    // local-only rows — the disk is the truth, not the chapter list
    for (const [number, localPath] of diskByNumber) {
        if (!listedNumbers.has(number)) {
            insert.run(entryId, `local:${number}`, path.basename(localPath).replace(/\.cbz$/i, ''), null, 'downloaded', localPath, now, now);
            kept++;
        }
    }
    return { kept, total };
}

/** Undo the latest source migration (restores entry fields + chapter rows). */
export function rollbackMigration(ctx: StoreContext, entryId: number): boolean {
    const snapshot = ctx.q.get<{ id: number; data: string }>('SELECT * FROM entry_snapshots WHERE entry_id = ? ORDER BY id DESC LIMIT 1', entryId);
    if (!snapshot) {
        return false;
    }
    // a corrupted snapshot (interrupted write) must not 500 the route — and
    // must not stay in place blocking every later rollback either
    let data: { entry: EntryRow; chapters: ChapterRow[] };
    try {
        data = JSON.parse(snapshot.data) as { entry: EntryRow; chapters: ChapterRow[] };
    } catch {
        ctx.db.db.prepare('DELETE FROM entry_snapshots WHERE id = ?').run(snapshot.id);
        throw new Error('Snapshot de migration corrompu — il a été supprimé, réessayez');
    }
    ctx.db.db
        .prepare(
            `UPDATE library SET source_id = ?, source_label = ?, manga_id = ?, title = ?, url = ?,
                migration_suggestion = NULL, migration_dismissed = NULL, check_failures = 0 WHERE id = ?`
        )
        .run(data.entry.source_id, data.entry.source_label, data.entry.manga_id, data.entry.title, data.entry.url, entryId);
    ctx.db.db.prepare('DELETE FROM library_chapters WHERE entry_id = ?').run(entryId);
    const insert = ctx.db.db.prepare(SQL_INSERT_CHAPTER_FULL);
    for (const chapter of data.chapters) {
        insert.run(entryId, chapter.chapter_id, chapter.title, chapter.language, chapter.status, chapter.path, chapter.discovered_at, chapter.downloaded_at);
    }
    ctx.db.db.prepare('DELETE FROM entry_snapshots WHERE id = ?').run(snapshot.id);
    return true;
}

function snapshotEntry(ctx: StoreContext, entryId: number, reason: string): void {
    const entry = getEntryRow(ctx, entryId);
    if (!entry) {
        return;
    }
    const chapters = ctx.q.all<ChapterRow>('SELECT * FROM library_chapters WHERE entry_id = ?', entryId);
    ctx.db.db
        .prepare('INSERT INTO entry_snapshots (entry_id, reason, data, at) VALUES (?, ?, ?, ?)')
        .run(entryId, reason, JSON.stringify({ entry, chapters }), new Date().toISOString());
}
