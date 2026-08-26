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
/** Download failures after which a source failover is probed immediately —
 *  without waiting for the next scheduler run (hours later). Content
 *  failures only (chapter gone server-side): infra failures feed the
 *  source-outage state instead and reach the failover through the
 *  scheduler backstop or once the outage escalates. */
export const DOWNLOAD_FAILOVER_FAILURES = 1;
/** Min delay between two migration probes for the same entry: a batch
 *  download on a dead source fails once per chapter and must not crawl the
 *  alternative sources for every single chapter. */
export const PROBE_COOLDOWN_MS = 15 * 60 * 1000;
/** Distinct entries of one source failing inside this window means a
 *  source-wide outage: migration is suspended and the failed jobs
 *  auto-retry instead — until the outage is escalated (below), the source
 *  comes back, or the outage is closed by silence. */
export const SOURCE_OUTAGE_ENTRIES = 3;
export const SOURCE_OUTAGE_WINDOW_MS = 60 * 60 * 1000;
/** A continuous outage older than this is escalated: per-entry failover
 *  probes are re-allowed (the source is probably dead for good — chapters
 *  must be delivered through a migration instead of waiting forever). */
export const OUTAGE_ESCALATION_MS = 3 * 60 * 60 * 1000;
/** An outage whose last observed failure is older than this is closed: the
 *  source quietly recovered. Closing resets the retry ladder of its failed
 *  jobs so they retry soon instead of waiting out their deep backoff slot. */
export const OUTAGE_SILENCE_MS = 2 * 60 * 60 * 1000;

/** Failure taxonomy for the failover policy. 'infra': the source (or its CDN,
 *  or the network) is unhealthy — waiting/retrying makes sense and a blind
 *  migration probe must not fire on the first casualty. 'content': the
 *  chapter/series is gone server-side — retrying the same URL can never
 *  succeed, so a failover probe is armed immediately. */
export type FailureClass = 'infra' | 'content';
/** Deterministic server-side-removal signals. Everything else — non-image
 *  page (CDN error), HTTP 5xx, 429, timeouts, network errors — defaults to
 *  'infra': the conservative choice (wait, don't migrate on ambiguity). */
const CONTENT_FAILURES = [/HTTP 404/, /HTTP 410/, /not found/i, /Page list is empty/];

export function classifyFailure(error: string | null | undefined): FailureClass {
    if (!error) {
        return 'infra';
    }
    return CONTENT_FAILURES.some(pattern => pattern.test(error)) ? 'content' : 'infra';
}

export class FailoverService {
    /** Entries currently probed by suggestIfIncomplete (re-entry guard). */
    private readonly detectionRunning = new Set<number>();
    /** Entries with a migration probe in flight — shared by the immediate
     *  download-failure path (index.ts), the scheduler backstop and the
     *  rematch actions, so at most one probe crawls for a given entry. */
    private readonly probing = new Set<number>();
    /** When each entry was last probed (probe-storm cooldown). */
    private readonly probeLastAt = new Map<number, number>();

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
     * Probe healthier sources when the current one carries very few chapters
     * and store a migration suggestion when an alternative offers at least
     * twice as many (existing banner flow). `manual` runs (dashboard bulk
     * tool) pass their own `maxChapters` and bypass the opt-in setting;
     * automatic runs keep the default. Returns true when a suggestion was
     * stored.
     */
    async suggestIfIncomplete(
        entry: { id: number; sourceId: string; title: string },
        chapterCount: number,
        opts: { manual?: boolean; maxChapters?: number } = {}
    ): Promise<boolean> {
        if (!opts.manual && !this.opts.isDetectionEnabled?.()) {
            return false;
        }
        if (chapterCount > (opts.maxChapters ?? INCOMPLETE_SOURCE_CHAPTERS)) {
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
            // the probe takes seconds of network: the entry may have been
            // migrated, suggested or deleted meanwhile — re-read and bail out
            const current = this.opts.store.getEntry(entry.id);
            if (!current || current.migrationSuggestion || current.sourceId !== entry.sourceId) {
                return false;
            }
            // never re-suggest a target the user explicitly dismissed
            const dismissed = current.dismissedMigration;
            const better = alternatives.find(
                alternative =>
                    alternative.chapterCount >= Math.max(chapterCount, 2) * IMPROVEMENT_FACTOR &&
                    !(dismissed && dismissed.sourceId === alternative.sourceId && dismissed.mangaId === alternative.mangaId)
            );
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

    /** Mark an entry as being probed; false when a probe already runs or the
     *  cooldown since the last probe has not elapsed. */
    tryBeginProbe(entryId: number): boolean {
        if (this.probing.has(entryId)) {
            return false;
        }
        if (Date.now() - (this.probeLastAt.get(entryId) ?? 0) < PROBE_COOLDOWN_MS) {
            return false;
        }
        this.probing.add(entryId);
        this.probeLastAt.set(entryId, Date.now());
        return true;
    }

    /** Release an entry after its migration probe finished (any outcome). */
    endProbe(entryId: number): void {
        this.probing.delete(entryId);
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
