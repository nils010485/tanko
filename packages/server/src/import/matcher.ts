/**
 * Import matching: every pending series of a job is searched on the usable
 * sources (bounded concurrency, capped source list) and its best candidates
 * are persisted. Extracted from ImportService, which delegates — the job
 * state stays in SQLite (import_series).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { SourceRegistry } from '@tanko/core';
import { sourceUsable } from '../languages.js';
import type { ImportOptions, MatchCandidate, SeriesRow, SourceInfo } from './service.js';
import { confidenceFor, stripTags, titleSimilarity } from './similarity.js';

const MATCH_CONCURRENCY = 4;

/** Cap on sources queried per series (exact match stops earlier); explicit sourceIds bypass it. */
const MAX_MATCH_SOURCES = 12;

/** Everything the matcher needs from its host ImportService. */
export interface MatcherContext {
    sql: DatabaseSync;
    registry: SourceRegistry;
    /** Jobs whose cancel() was called — checked between series and between sources. */
    cancelRequested: Set<number>;
    getPreferredLanguages: () => string[];
    listSources: () => Promise<SourceInfo[]>;
}

function now(): string {
    return new Date().toISOString();
}

/** Match every pending series against usable sources (bounded concurrency). */
export async function matchAll(ctx: MatcherContext, jobId: number, options: ImportOptions): Promise<void> {
    const preferred = ctx.getPreferredLanguages();
    let sources = await ctx.listSources();
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
            healthRank(a) - healthRank(b) || kindRank(a) - kindRank(b) || Number(multilingual(b)) - Number(multilingual(a)) || a.label.localeCompare(b.label)
    );
    // without an explicit list, avoid catalog-scanning hundreds of untested legacy sources
    if (!options.sourceIds) {
        sources = sources.slice(0, MAX_MATCH_SOURCES);
    }
    if (sources.length === 0) {
        throw new Error('Aucune source utilisable (langue/santé) pour le matching');
    }

    const pending = () =>
        ctx.sql.prepare(`SELECT * FROM import_series WHERE job_id = ? AND status = 'pending' ORDER BY name LIMIT 1`).get(jobId) as unknown as
            | SeriesRow
            | undefined;

    const concurrency = Math.max(1, options.concurrency ?? MATCH_CONCURRENCY);
    const worker = async () => {
        for (;;) {
            if (ctx.cancelRequested.has(jobId)) {
                return;
            }
            const series = pending();
            if (!series) {
                return;
            }
            // claim it so another worker does not take the same row
            ctx.sql
                .prepare(`UPDATE import_series SET status = 'matching', updated_at = ? WHERE job_id = ? AND path = ? AND status = 'pending'`)
                .run(now(), jobId, series.path);
            try {
                await matchSeries(ctx, jobId, series, sources);
            } catch (error) {
                console.warn(`[import] match failed for "${series.name}":`, (error as Error).message);
                ctx.sql
                    .prepare(
                        `UPDATE import_series SET status = 'matched', confidence = 'none', error = ?, updated_at = ?
                     WHERE job_id = ? AND path = ?`
                    )
                    .run((error as Error).message, now(), jobId, series.path);
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
}

export async function matchSeries(ctx: MatcherContext, jobId: number, series: SeriesRow, sources: SourceInfo[]): Promise<void> {
    const needle = series.needle || series.name;
    // try the raw name, then tag-stripped variants ("Dungeon Reset [Official]" -> "Dungeon Reset")
    const queries = [...new Set([needle, stripTags(needle).trim(), stripTags(series.name).trim()].filter(query => query.length > 2))];
    const candidates: MatchCandidate[] = [];
    let best: MatchCandidate | null = null;

    for (const source of sources) {
        if (ctx.cancelRequested.has(jobId)) {
            return;
        }
        try {
            const adapter = await ctx.registry.get(source.id);
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
    ctx.sql
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
            now(),
            jobId,
            series.path
        );
}
