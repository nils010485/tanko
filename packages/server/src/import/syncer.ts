/**
 * Import sync: every confirmed series of a job is added to the library with
 * its local chapter files attached (number pairing, ordinal fallback for
 * re-numbered seasons). Extracted from ImportService, which delegates — the
 * job state stays in SQLite (import_series).
 */
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChapterInfo, SourceAdapter, SourceRegistry } from '@tanko/core';
import { chapterAllowed } from '../languages.js';
import type { LibraryStore } from '../library/store.js';
import { withTimeout } from '../util/timeout.js';
import { parseChapterNumber, scanLibrary } from './scanner.js';
import type { ImportOptions, JobRow, JobStatus, SeriesRow } from './service.js';

/** Everything the syncer needs from its host ImportService. */
export interface SyncerContext {
    sql: DatabaseSync;
    registry: SourceRegistry;
    store: LibraryStore;
    /** Jobs whose cancel() was called — checked between series. */
    cancelRequested: Set<number>;
    getPreferredLanguages: () => string[];
    /** Read a job row (its options) — the service's _job. */
    getJob(jobId: number): JobRow | undefined;
    /** Persist a job status transition — the service's _setStatus. */
    setStatus(jobId: number, status: JobStatus): void;
    /** Notified after each settled series (Activity job progress). */
    onProgress?: (jobId: number) => void;
}

function now(): string {
    return new Date().toISOString();
}

/** Sync every confirmed series: add to the library, mark local chapters as downloaded. */
export async function syncAll(ctx: SyncerContext, jobId: number): Promise<void> {
    const options: ImportOptions = JSON.parse(ctx.getJob(jobId)?.options || '{}');
    const preferred = ctx.getPreferredLanguages();
    const rows = ctx.sql
        .prepare(`SELECT * FROM import_series WHERE job_id = ? AND confirmed = 1 AND status != 'synced' ORDER BY name`)
        .all(jobId) as unknown as SeriesRow[];

    for (const series of rows) {
        if (ctx.cancelRequested.has(jobId)) {
            ctx.setStatus(jobId, 'ready');
            return;
        }
        try {
            const result = await syncSeries(ctx, series, options.autoDownload === true, preferred);
            ctx.sql
                .prepare(
                    `UPDATE import_series SET status = 'synced', matched = ?, local_chapters = ?, source_chapters = ?,
                        match_mode = ?, entry_id = ?, error = NULL, updated_at = ?
                 WHERE job_id = ? AND path = ?`
                )
                .run(result.matched, result.localChapters, result.sourceChapters, result.mode, result.entryId, now(), jobId, series.path);
        } catch (error) {
            console.warn(`[import] sync failed for "${series.name}":`, (error as Error).message);
            ctx.sql
                .prepare(`UPDATE import_series SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ? AND path = ?`)
                .run((error as Error).message, now(), jobId, series.path);
        }
        ctx.onProgress?.(jobId);
    }
    ctx.setStatus(jobId, 'done');
}

/**
 * One series: local files <-> source chapters, matched by chapter number.
 * When numbers barely match but both sides agree on the count (re-numbered
 * seasons), pairChapters falls back to positional alignment — flagged as
 * 'ordinal'.
 */
async function syncSeries(
    ctx: SyncerContext,
    series: SeriesRow,
    autoDownload: boolean,
    preferred: string[]
): Promise<{
    matched: number;
    localChapters: number;
    sourceChapters: number;
    mode: 'number' | 'ordinal';
    entryId: number;
    reused?: boolean;
}> {
    const { source_id: sourceId, manga_id: mangaId, manga_title: mangaTitle } = series;
    if (!sourceId || !mangaId || !mangaTitle) {
        throw new Error(`Series "${series.name}" has no confirmed source match`);
    }
    const local = localChapters(series);
    // duplicate guard: the series is already tracked (typically on another
    // source — a re-import whose search matched differently): attach the
    // local files to the existing entry instead of creating a duplicate
    const existing = ctx.store.findEntryByTitle(mangaTitle);
    if (existing) {
        const { attached, registered } = ctx.store.registerLocalChapters(existing.id, local.byNumber);
        const matched = attached + registered;
        console.log(
            `[import] "${series.name}" déjà suivie via ${existing.source_label} (#${existing.id}) — fichiers rattachés à l'entrée existante (${matched} chapitres, dont ${registered} locaux hors source)`
        );
        return {
            matched,
            localChapters: local.total,
            sourceChapters: ctx.store.listChapters(existing.id).length,
            mode: 'number' as const,
            entryId: existing.id,
            reused: true
        };
    }
    const source = await ctx.registry.get(sourceId);
    if (!source) {
        throw new Error(`Source "${sourceId}" introuvable`);
    }
    // fetch the source chapters BEFORE creating the library entry: a series
    // whose source is dead/emptied must not leave a ghost entry behind
    const { chapters, byNumber: sourceByNumber } = await sourceChapters({ id: mangaId, title: mangaTitle }, source, preferred);
    const { entry } = await ctx.store.addEntry({
        sourceId,
        mangaId,
        title: mangaTitle,
        autoDownload
    });
    // the scanned folder is the entry's home: adopt it as the canonical
    // directory when it lies inside the data directory, so downloads
    // complete the imported folder instead of starting a sibling
    ctx.store.adoptDirectory(entry.id, series.path);
    const { pairs, mode } = pairChapters(local.byNumber, sourceByNumber);

    for (const pair of pairs) {
        ctx.store.markChapter(entry.id, pair.chapterId, 'downloaded', pair.localPath, 'import');
    }
    // files with no source counterpart stay visible as local-only chapters
    const { registered } = ctx.store.registerLocalChapters(entry.id, local.byNumber);
    return { matched: pairs.length + registered, localChapters: local.total, sourceChapters: chapters.length, mode, entryId: entry.id };
}

/** Local chapters of a series folder: number -> file path (first occurrence wins), plus total count. */
function localChapters(series: SeriesRow): { byNumber: Map<number, string>; total: number } {
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
async function sourceChapters(
    manga: { id: string; title: string },
    source: SourceAdapter,
    preferred: string[]
): Promise<{
    chapters: ChapterInfo[];
    byNumber: Map<number, ChapterInfo>;
}> {
    // the cancel flag is checked between series — a hanging connector would
    // defeat it, so bound the call like the scheduler does
    const allChapters = await withTimeout(source.getChapters(manga, { languages: preferred }), 2 * 60 * 1000, `getChapters(${manga.title})`);
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
function pairChapters(
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
