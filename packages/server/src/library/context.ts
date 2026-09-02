/**
 * Shared context of the library modules: typed query helpers plus the store's
 * constructor options (registry, settings, language preference), passed down
 * by LibraryStore to the extracted modules (outages, chapters, migration).
 */
import path from 'node:path';
import type { SourceRegistry } from '@tanko/core';
import type { Database } from '../db.js';
import { chapterPaths, directoryKey, outputExists, resolveSeriesDirectory } from '../downloader/paths.js';
import type { QueueSettings } from '../downloader/queue.js';
import type { EntryRow } from './rows.js';

/** Typed SQLite query helpers (node:sqlite returns untyped rows). */
export interface Queries {
    all<T>(sql: string, ...params: Array<string | number | null>): T[];
    get<T>(sql: string, ...params: Array<string | number | null>): T | undefined;
}

/** Everything the extracted library modules need from their host store. */
export interface StoreContext {
    db: Database;
    q: Queries;
    registry: SourceRegistry;
    queueSettings: QueueSettings;
    /** Preferred chapter languages (ISO codes); empty = keep everything. */
    getPreferredLanguages?: () => string[];
}

/** Build the typed query helpers for a database handle. */
export function makeQueries(db: Database): Queries {
    return {
        all<T>(sql: string, ...params: Array<string | number | null>): T[] {
            return db.db.prepare(sql).all(...params) as unknown as T[];
        },
        get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
            return db.db.prepare(sql).get(...params) as unknown as T | undefined;
        }
    };
}

export function getEntryRow(ctx: StoreContext, entryId: number): EntryRow | undefined {
    return ctx.q.get<EntryRow>('SELECT * FROM library WHERE id = ?', entryId);
}

/** Directory holding the entry's files: the deepest common ancestor of the
 *  downloaded chapter paths first (strongest signal — absolute paths survive
 *  source migrations and imports from folders outside the data directory),
 *  then the stored canonical folder, falling back to the configured layout. */
export function seriesDirectory(ctx: StoreContext, entryId: number, row?: EntryRow): string | null {
    const entry = row ?? getEntryRow(ctx, entryId);
    if (!entry) {
        return null;
    }
    const paths = ctx.q
        .all<{ path: string }>('SELECT path FROM library_chapters WHERE entry_id = ? AND path IS NOT NULL AND length(path) > 0', entryId)
        .map(item => item.path.split(/[\\/]/));
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
    const settings = ctx.queueSettings;
    const guard = ownershipGuard(ctx.q, settings.dataDirectory, entryId);
    // stored canonical folder: survives migrations and layout changes, and
    // covers entries with no recorded paths yet
    if (entry.directory) {
        return resolveSeriesDirectory(path.join(settings.dataDirectory, ...entry.directory.split('/')), guard);
    }
    const target = chapterPaths(settings.dataDirectory, entry.source_label, entry.title, 'Chapter 0', settings.directoryLayout, undefined, guard).cbzFile;
    return path.dirname(target);
}

/** Whether a chapter file already exists on disk in the configured layout —
 *  the entry's stored directory when it has one. */
export function isDownloaded(
    ctx: StoreContext,
    sourceLabel: string,
    mangaTitle: string,
    chapterTitle: string,
    entry?: { id: number; directory: string | null }
): boolean {
    const override = entry?.directory ? path.join(ctx.queueSettings.dataDirectory, ...entry.directory.split('/')) : undefined;
    const guard = ownershipGuard(ctx.q, ctx.queueSettings.dataDirectory, entry?.id);
    const paths = chapterPaths(ctx.queueSettings.dataDirectory, sourceLabel, mangaTitle, chapterTitle, ctx.queueSettings.directoryLayout, override, guard);
    return outputExists(paths, ctx.queueSettings.chapterFormat);
}

/** Predicate rejecting loose folder matches another entry owns (same folder
 *  under a case/punctuation variant): two entries must never converge on one
 *  folder through spelling. `exceptEntryId` keeps an entry's own folder
 *  adoptable. */
export function ownershipGuard(q: Queries, dataDirectory: string, exceptEntryId?: number): (directory: string) => boolean {
    return (directory: string): boolean => {
        const rel = path.relative(path.resolve(dataDirectory), path.resolve(directory));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return false;
        }
        const wanted = directoryKey(rel.split(path.sep).join('/'));
        const sql =
            exceptEntryId == null
                ? 'SELECT directory FROM library WHERE directory IS NOT NULL'
                : 'SELECT directory FROM library WHERE directory IS NOT NULL AND id != ?';
        const params = exceptEntryId == null ? [] : [exceptEntryId];
        return q.all<{ directory: string }>(sql, ...params).some(row => directoryKey(row.directory) === wanted);
    };
}
