/**
 * Shared context of the library modules: typed query helpers plus the store's
 * constructor options (registry, settings, language preference), passed down
 * by LibraryStore to the extracted modules (outages, chapters, migration).
 */
import path from 'node:path';
import type { SourceRegistry } from '@tanko/core';
import type { Database } from '../db.js';
import { chapterPaths, outputExists } from '../downloader/paths.js';
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

/** Directory holding the entry's files: deepest common ancestor of the
 *  downloaded chapter paths, falling back to the configured layout. */
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
    const target = chapterPaths(settings.dataDirectory, entry.source_label, entry.title, 'Chapter 0', settings.directoryLayout).cbzFile;
    return path.dirname(target);
}

/** Whether a chapter file already exists on disk in the configured layout. */
export function isDownloaded(ctx: StoreContext, sourceLabel: string, mangaTitle: string, chapterTitle: string): boolean {
    const paths = chapterPaths(ctx.queueSettings.dataDirectory, sourceLabel, mangaTitle, chapterTitle, ctx.queueSettings.directoryLayout);
    return outputExists(paths, ctx.queueSettings.chapterFormat);
}
