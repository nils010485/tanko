/**
 * Source failover: when an entry's source repeatedly fails (dead site,
 * Cloudflare wall, removed manga), find the same series on another healthy,
 * language-compatible source and migrate the entry — downloaded chapters keep
 * their local files (matched by chapter number) and a snapshot allows undo.
 *
 * High-confidence matches migrate automatically; ambiguous ones are stored as
 * a suggestion for the dashboard.
 */
import type { SourceRegistry } from '@tanko/core';
import type { SourceAlternativeDto } from '@tanko/shared';
import { confidenceFor, stripTags, titleSimilarity } from '../import/similarity.js';
import { chapterAllowed, sourceUsable } from '../languages.js';
import type { LibraryStore, MigrationTarget } from './store.js';

/** Healthy sources first. */
function byHealth(a: SourceInfo, b: SourceInfo): number {
    return (a.health === 'ok' ? -1 : 1) - (b.health === 'ok' ? -1 : 1);
}

/** Native connectors before legacy ones. */
function byKind(a: SourceInfo, b: SourceInfo): number {
    return (a.kind === 'native' ? -1 : 1) - (b.kind === 'native' ? -1 : 1);
}

import type { SourceInfo } from '../import/service.js';

/** Starved-source detection: entries with at most this many chapters are
 *  searched elsewhere (opt-in setting). */
export const INCOMPLETE_SOURCE_CHAPTERS = 10;
/** An alternative must offer at least this multiple of the current chapter
 *  count to be worth suggesting. */
const IMPROVEMENT_FACTOR = 2;

export class FailoverService {
    /** Entries currently probed by suggestIfIncomplete (re-entry guard). */
    private readonly detectionRunning = new Set<number>();

    constructor(
        private readonly opts: {
            registry: SourceRegistry;
            store: LibraryStore;
            listSources: () => Promise<SourceInfo[]>;
            getPreferredLanguages: () => string[];
            /** Opt-in starved-source detection (Settings); absent = disabled. */
            isDetectionEnabled?: () => boolean;
        }
    ) {}

    /**
     * Look for an alternative source carrying the same series.
     * Returns the best candidate with its confidence tier.
     */
    async findAlternative(entry: { id: number; sourceId: string; title: string }): Promise<{
        best: MigrationTarget | null;
        confidence: 'auto' | 'review' | 'none';
        candidates: MigrationTarget[];
    }> {
        const preferred = this.opts.getPreferredLanguages();
        const sources = (await this.opts.listSources())
            .filter(source => !source.hidden && source.id !== entry.sourceId && sourceUsable(source.tags, preferred))
            .sort((a, b) => byHealth(a, b) || byKind(a, b) || a.label.localeCompare(b.label))
            .slice(0, 12);

        const queries = [...new Set([entry.title, stripTags(entry.title).trim()].filter(query => query.length > 2))];
        const candidates: MigrationTarget[] = [];
        let best: MigrationTarget | null = null;

        for (const source of sources) {
            try {
                const adapter = await this.opts.registry.get(source.id);
                if (!adapter) {
                    continue;
                }
                const results: Array<{ id: string; title: string; url?: string }> = [];
                for (const query of queries) {
                    results.push(...(await adapter.searchMangas(query)));
                    if (results.length > 0) {
                        break;
                    }
                }
                for (const manga of results.slice(0, 8)) {
                    const score = titleSimilarity(entry.title, manga.title);
                    const candidate: MigrationTarget = {
                        sourceId: source.id,
                        sourceLabel: source.label,
                        mangaId: manga.id,
                        mangaTitle: manga.title,
                        url: manga.url,
                        score
                    };
                    candidates.push(candidate);
                    if (!best || (candidate.score || 0) > (best.score || 0)) {
                        best = candidate;
                    }
                }
            } catch {
                /* a broken alternative is simply skipped */
            }
        }

        candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
        return { best, confidence: confidenceFor(best?.score), candidates: candidates.slice(0, 8) };
    }

    /**
     * Chapter-counted alternatives for the manual source picker: the best
     * candidate per source, probed in score order (broken ones are skipped),
     * sorted by chapter count so incomplete sources are obvious.
     */
    async listAlternatives(entry: { id: number; sourceId: string; title: string }): Promise<SourceAlternativeDto[]> {
        const { candidates } = await this.findAlternative(entry);
        const perSource = new Map<string, MigrationTarget>();
        for (const candidate of candidates) {
            if (!perSource.has(candidate.sourceId)) {
                perSource.set(candidate.sourceId, candidate);
            }
        }
        const preferred = this.opts.getPreferredLanguages();
        const alternatives: SourceAlternativeDto[] = [];
        for (const candidate of perSource.values()) {
            if (alternatives.length >= 6) {
                break; // bound the latency: 6 distinct sources max
            }
            try {
                const adapter = await this.opts.registry.get(candidate.sourceId);
                if (!adapter) {
                    continue;
                }
                const chapters = await adapter.getChapters({ id: candidate.mangaId, title: candidate.mangaTitle });
                const chapterCount = chapters.filter(chapter => chapterAllowed(chapter.language, preferred)).length;
                if (chapterCount === 0) {
                    continue;
                }
                alternatives.push({ ...candidate, chapterCount });
            } catch {
                /* a broken alternative is simply skipped */
            }
        }
        return alternatives.sort((a, b) => b.chapterCount - a.chapterCount || (b.score ?? 0) - (a.score ?? 0));
    }

    /**
     * Opt-in starved-source detection: after a check that found nothing new,
     * an entry carrying at most INCOMPLETE_SOURCE_CHAPTERS chapters is searched
     * on the other sources; when one offers at least twice as many, it is
     * stored as a migration suggestion (existing banner flow). Returns true
     * when a suggestion was stored.
     */
    async suggestIfIncomplete(entry: { id: number; sourceId: string; title: string }, chapterCount: number): Promise<boolean> {
        if (!this.opts.isDetectionEnabled?.()) {
            return false;
        }
        if (chapterCount > INCOMPLETE_SOURCE_CHAPTERS) {
            return false;
        }
        if (this.detectionRunning.has(entry.id)) {
            return false;
        }
        if (this.opts.store.getEntry(entry.id)?.migrationSuggestion) {
            return false; // a suggestion is already awaiting review
        }
        this.detectionRunning.add(entry.id);
        try {
            const alternatives = await this.listAlternatives(entry);
            const better = alternatives.find(alternative => alternative.chapterCount >= chapterCount * IMPROVEMENT_FACTOR);
            if (!better) {
                return false;
            }
            this.opts.store.setMigrationSuggestion(entry.id, better);
            console.log(`[failover] "${entry.title}" : source incomplète (${chapterCount} ch.), suggestion ${better.sourceLabel} (${better.chapterCount} ch.)`);
            return true;
        } finally {
            this.detectionRunning.delete(entry.id);
        }
    }

    /**
     * Try to migrate an entry to a healthier source.
     * auto=true: apply only high-confidence matches, otherwise store a suggestion.
     * Returns 'migrated' | 'suggested' | 'none'.
     */
    async maybeMigrate(entry: { id: number; sourceId: string; title: string }, auto = true): Promise<'migrated' | 'suggested' | 'none'> {
        const { candidates } = await this.findAlternative(entry);
        if (candidates.length === 0) {
            return 'none';
        }
        // Validate candidates in score order: the best match may sit on a
        // broken connector, the runner-up on a perfectly usable source.
        const preferred = this.opts.getPreferredLanguages();
        const triedSources = new Set<string>();
        let best: MigrationTarget | null = null;
        let confidence: 'auto' | 'review' | 'none' = 'none';
        for (const candidate of candidates) {
            if (triedSources.has(candidate.sourceId)) {
                continue;
            }
            triedSources.add(candidate.sourceId);
            if (triedSources.size > 4) {
                break; // bound the latency: 4 distinct sources max
            }
            const adapter = await this.opts.registry.get(candidate.sourceId);
            if (!adapter) {
                continue;
            }
            try {
                const chapters = await adapter.getChapters({ id: candidate.mangaId, title: candidate.mangaTitle });
                const chapter = chapters.find(item => chapterAllowed(item.language, preferred));
                if (!chapter) {
                    console.log(`[failover] "${entry.title}" : ${candidate.sourceLabel} ne sert aucun chapitre dans les langues préférées`);
                    continue;
                }
                // a connector can list chapters but serve broken page lists
                // (MangaHere grabbing): probe one chapter before committing
                const pages = await adapter.getPages({ id: candidate.mangaId, title: candidate.mangaTitle }, { id: chapter.id, title: chapter.title });
                if (!pages.length) {
                    throw new Error('page list is empty');
                }
            } catch (error) {
                console.log(`[failover] "${entry.title}" : ${candidate.sourceLabel} inutilisable (${(error as Error).message})`);
                continue;
            }
            best = candidate;
            confidence = confidenceFor(candidate.score);
            break;
        }
        if (!best || confidence === 'none') {
            return 'none';
        }
        if (confidence === 'auto' && auto) {
            const result = await this.opts.store.migrateEntry(entry.id, best);
            console.log(`[failover] "${entry.title}" migré vers ${best.sourceLabel} (${result.kept}/${result.total} chapitres conservés)`);
            return 'migrated';
        }
        this.opts.store.setMigrationSuggestion(entry.id, best);
        return 'suggested';
    }
}
