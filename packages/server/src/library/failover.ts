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
import type { SourceInfo } from '../import/service.js';
import { AUTO_THRESHOLD, confidenceFor, stripTags, titleSimilarity } from '../import/similarity.js';
import { chapterAllowed, sourceUsable } from '../languages.js';
import type { LibraryStore, MigrationTarget } from './store.js';

/** Healthy sources first (natives outrank them anyway — see findAlternative). */
function byHealth(a: SourceInfo, b: SourceInfo): number {
    return (a.health === 'ok' ? -1 : 1) - (b.health === 'ok' ? -1 : 1);
}

/** Native connectors before legacy ones (cheap APIs, highest coverage). */
function byKind(a: SourceInfo, b: SourceInfo): number {
    return (a.kind === 'native' ? -1 : 1) - (b.kind === 'native' ? -1 : 1);
}

/** Reject after `ms`, whatever settles the race first — the loser's timer is
 * cleared so a crawl of hundreds of searches leaks nothing. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Validation budget for one candidate's chapter list. */
const VALIDATION_TIMEOUT_MS = 20_000;
/** Validation budget for a page-list probe — sequential per-page requests
 * on long chapters legitimately take tens of seconds. */
const PAGE_PROBE_TIMEOUT_MS = 90_000;
/** Search results kept per source / candidates kept per round. */
const MAX_SEARCH_RESULTS = 8;
/** Distinct alternatives shown by the manual source picker. */
const MAX_PICKER_ALTERNATIVES = 6;
/** Distinct candidates fully validated per round. */
const MAX_VALIDATIONS_PER_ROUND = 4;
/** Parallel searches per wave of the alternative crawl. Dead sites hang
 * until their fetch timeout, so every search is individually bounded below
 * and only wave STARTS are deadline-bound. */
const CRAWL_CONCURRENCY = 24;
/** Per-source search budget: a source that cannot answer a title search in
 * time is useless for a migration probe — its result is dropped, not awaited. */
const SEARCH_TIMEOUT_MS = 10_000;
/** Automatic failover hunts: wall-clock budget per crawl round. */
const CRAWL_DEADLINE_MS = 60_000;
/** Automatic failover hunts: sources crawled at most per round. */
const CRAWL_SOURCES = 128;
/** Manual source picker: crawl essentially every usable source, under a
 * stricter wall-clock budget — the user waited for an answer, not forever. */
const PICKER_SOURCES = 500;
const PICKER_DEADLINE_MS = 60_000;
/** Crawl-and-validate rounds: each round excludes the sources already
 * searched or rejected, going deeper — a perfect title match on a source
 * without preferred-language chapters must not end the hunt. */
const VALIDATION_ROUNDS = 4;

/** Starved-source detection: entries with at most this many chapters are
 *  searched elsewhere (opt-in setting). */
export const INCOMPLETE_SOURCE_CHAPTERS = 10;
/** An alternative must offer at least this multiple of the current chapter
 *  count to be worth suggesting. */
const IMPROVEMENT_FACTOR = 2;
/** Stalled-source detection: an alternative must offer at least this many
 *  MORE chapters than the current source to be worth suggesting — not a
 *  multiple: a series stalled at ch. 150 must be matched by ch. 152, never
 *  ch. 300. The margin absorbs sources counting prologues/.5/bonus
 *  chapters differently. */
const STALLED_MARGIN_CHAPTERS = 2;
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
const CONTENT_FAILURES = [/HTTP 404/, /HTTP 410/, /not found/i, /Page list is empty/, /serves no images/];

export function classifyFailure(error: string | null | undefined): FailureClass {
    if (!error) {
        return 'infra';
    }
    return CONTENT_FAILURES.some(pattern => pattern.test(error)) ? 'content' : 'infra';
}

export class FailoverService {
    /** Entries currently probed by a suggestion detection (re-entry guard). */
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
            /** Opt-in stalled-source detection (Settings); absent = disabled. */
            isStalledDetectionEnabled?: () => boolean;
            /** Webhook hook: a migration suggestion was stored (banner flow). */
            onSuggestion?: (entry: { id: number; title: string }, target: { sourceLabel: string; chapterCount?: number }, currentChapters: number) => void;
        }
    ) {}

    /**
     * One crawl round: search alternative sources in parallel waves until a
     * high-confidence match appears or the budget runs out. Returns the
     * scored candidates (best first) plus every source id attempted — callers
     * exclude those from the next round.
     */
    async findAlternative(
        entry: { id: number; sourceId: string; title: string },
        opts: { maxSources?: number; deadlineMs?: number; excludeSources?: ReadonlySet<string> } = {}
    ): Promise<{
        candidates: MigrationTarget[];
        searched: string[];
    }> {
        const preferred = this.opts.getPreferredLanguages();
        // natives (fast APIs) first, then healthy sources; the label tiebreak
        // is arbitrary — the cap below, not this order, is the real bound
        const sources = (await this.opts.listSources())
            .filter(source => !source.hidden && source.id !== entry.sourceId && !opts.excludeSources?.has(source.id) && sourceUsable(source.tags, preferred))
            .sort((a, b) => byKind(a, b) || byHealth(a, b) || a.label.localeCompare(b.label))
            .slice(0, opts.maxSources ?? CRAWL_SOURCES);

        const queries = [...new Set([entry.title, stripTags(entry.title).trim()].filter(query => query.length > 2))];
        const deadline = Date.now() + (opts.deadlineMs ?? CRAWL_DEADLINE_MS);
        const candidates: MigrationTarget[] = [];
        // every attempted source counts as done (connectors fail deterministically);
        // retried timeouts would just burn the next round's budget too
        const searched: string[] = [];
        for (let index = 0; index < sources.length; index += CRAWL_CONCURRENCY) {
            if (index > 0 && Date.now() > deadline) {
                break; // budget exhausted — never start another wave of dead sites
            }
            const waveSources = sources.slice(index, index + CRAWL_CONCURRENCY);
            searched.push(...waveSources.map(source => source.id));
            const wave = await Promise.all(
                waveSources.map(async source => {
                    try {
                        const adapter = await this.opts.registry.get(source.id);
                        if (!adapter) {
                            return [] as MigrationTarget[];
                        }
                        const results: Array<{ id: string; title: string; url?: string }> = [];
                        for (const query of queries) {
                            const search = adapter.searchMangas(query);
                            // a losing race must not leave an orphaned rejection
                            search.catch(() => undefined);
                            const found = await withTimeout(search, SEARCH_TIMEOUT_MS, 'search timeout');
                            results.push(...found);
                            if (results.length > 0) {
                                break;
                            }
                        }
                        return results.slice(0, MAX_SEARCH_RESULTS).map(manga => ({
                            sourceId: source.id,
                            sourceLabel: source.label,
                            mangaId: manga.id,
                            mangaTitle: manga.title,
                            url: manga.url,
                            score: titleSimilarity(entry.title, manga.title)
                        }));
                    } catch {
                        return [] as MigrationTarget[]; // a broken alternative is simply skipped
                    }
                })
            );
            candidates.push(...wave.flat());
            const bestScore = Math.max(0, ...candidates.map(candidate => candidate.score ?? 0));
            if (bestScore >= AUTO_THRESHOLD) {
                break;
            }
        }

        candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
        return { candidates: candidates.slice(0, MAX_SEARCH_RESULTS), searched };
    }

    /** Shared round driver: yields each round's candidates (best first) and
     * internally tracks the attempted sources so every round goes deeper.
     * Ends after VALIDATION_ROUNDS or once no source is left to crawl. */
    private async *_crawlRounds(
        entry: { id: number; sourceId: string; title: string },
        opts: { maxSources?: number; deadlineMs?: number } = {}
    ): AsyncGenerator<MigrationTarget[]> {
        const done = new Set<string>(); // attempted and/or rejected sources
        for (let round = 0; round < VALIDATION_ROUNDS; round++) {
            const { candidates, searched } = await this.findAlternative(entry, { ...opts, excludeSources: done });
            for (const id of searched) {
                done.add(id);
            }
            if (searched.length === 0) {
                return; // no usable source left — deeper rounds are pointless
            }
            yield candidates;
        }
    }

    /**
     * Chapter-counted alternatives for the manual source picker: the best
     * candidate per source, probed in score order (broken ones are skipped),
     * sorted by chapter count so incomplete sources are obvious. Crawls in
     * rounds: a perfect title match that only carries foreign-language rips
     * must not hide the real host deeper in the source list.
     */
    async listAlternatives(entry: { id: number; sourceId: string; title: string }): Promise<SourceAlternativeDto[]> {
        const preferred = this.opts.getPreferredLanguages();
        const alternatives: SourceAlternativeDto[] = [];
        for await (const candidates of this._crawlRounds(entry, { maxSources: PICKER_SOURCES, deadlineMs: PICKER_DEADLINE_MS })) {
            const perSource = new Map<string, MigrationTarget>();
            for (const candidate of candidates) {
                if (!perSource.has(candidate.sourceId)) {
                    perSource.set(candidate.sourceId, candidate);
                }
            }
            for (const candidate of perSource.values()) {
                if (alternatives.length >= MAX_PICKER_ALTERNATIVES) {
                    break; // bound the latency: 6 distinct sources max
                }
                const alternative = await this._countChapters(candidate, preferred);
                if (alternative) {
                    alternatives.push(alternative);
                }
            }
            if (alternatives.length >= MAX_PICKER_ALTERNATIVES) {
                break;
            }
        }
        return alternatives.sort((a, b) => b.chapterCount - a.chapterCount || (b.score ?? 0) - (a.score ?? 0));
    }

    /** Chapters of a candidate in the preferred languages, null when the
     * source is broken or carries none of them. */
    private async _countChapters(candidate: MigrationTarget, preferred: string[]): Promise<SourceAlternativeDto | null> {
        try {
            const adapter = await this.opts.registry.get(candidate.sourceId);
            if (!adapter) {
                return null;
            }
            const chapters = await withTimeout(
                adapter.getChapters({ id: candidate.mangaId, title: candidate.mangaTitle }),
                VALIDATION_TIMEOUT_MS,
                'chapter list timeout'
            );
            const chapterCount = chapters.filter(chapter => chapterAllowed(chapter.language, preferred)).length;
            return chapterCount > 0 ? { ...candidate, chapterCount } : null;
        } catch {
            return null; // a broken alternative is simply skipped
        }
    }

    /**
     * Probe healthier sources when the current one carries very few chapters
     * and store a migration suggestion when an alternative offers at least
     * twice as many (existing banner flow). `manual` runs (dashboard bulk
     * tool) pass their own `maxChapters` and bypass the opt-in setting;
     * automatic runs keep the default. Returns the outcome for the caller's
     * budget bookkeeping: 'skipped' (detection disabled, threshold exceeded,
     * probe already running, suggestion pending) crawled nothing and must
     * cost nothing.
     */
    async suggestIfIncomplete(
        entry: { id: number; sourceId: string; title: string },
        chapterCount: number,
        opts: { manual?: boolean; maxChapters?: number } = {}
    ): Promise<'suggested' | 'miss' | 'skipped'> {
        if (!opts.manual && !this.opts.isDetectionEnabled?.()) {
            return 'skipped';
        }
        if (chapterCount > (opts.maxChapters ?? INCOMPLETE_SOURCE_CHAPTERS)) {
            return 'skipped';
        }
        if (this.detectionRunning.has(entry.id) || this.opts.store.getEntry(entry.id)?.migrationSuggestion) {
            return 'skipped';
        }
        const suggested = await this._probeAndSuggest(
            entry,
            chapterCount,
            alternative => alternative.chapterCount >= Math.max(chapterCount, 2) * IMPROVEMENT_FACTOR,
            'source incomplète'
        );
        return suggested ? 'suggested' : 'miss';
    }

    /**
     * Probe the other sources when a series looks stalled relative to its
     * own release rhythm (candidates come from the store's staleness
     * tracking) and store a migration suggestion when an alternative offers
     * at least STALLED_MARGIN_CHAPTERS more chapters. Suggestion only: the
     * current source still answers, and a wrong migration costs more than a
     * late one. Returns the outcome for the caller's back-off bookkeeping:
     * 'skipped' (detection disabled, probe already running, suggestion
     * pending) probed nothing and must move nothing.
     */
    async suggestIfStalled(entry: { id: number; sourceId: string; title: string }, chapterCount: number): Promise<'suggested' | 'miss' | 'skipped'> {
        if (!this.opts.isStalledDetectionEnabled?.()) {
            return 'skipped';
        }
        if (this.detectionRunning.has(entry.id) || this.opts.store.getEntry(entry.id)?.migrationSuggestion) {
            return 'skipped';
        }
        const suggested = await this._probeAndSuggest(
            entry,
            chapterCount,
            alternative => alternative.chapterCount >= chapterCount + STALLED_MARGIN_CHAPTERS,
            'source sans nouveautés'
        );
        return suggested ? 'suggested' : 'miss';
    }

    /** Shared probe core of the suggestion regimes: crawl the alternatives,
     *  keep the first one satisfying the regime's predicate (never a target
     *  the user dismissed), store the suggestion and notify. Returns true
     *  when a suggestion was stored. */
    private async _probeAndSuggest(
        entry: { id: number; sourceId: string; title: string },
        chapterCount: number,
        isBetter: (alternative: SourceAlternativeDto) => boolean,
        reason: string
    ): Promise<boolean> {
        this.detectionRunning.add(entry.id); // guards live in the callers
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
                alternative => isBetter(alternative) && !(dismissed && dismissed.sourceId === alternative.sourceId && dismissed.mangaId === alternative.mangaId)
            );
            if (!better) {
                return false;
            }
            this.opts.store.setMigrationSuggestion(entry.id, better);
            this.opts.onSuggestion?.(entry, better, chapterCount);
            console.log(`[failover] "${entry.title}" : ${reason} (${chapterCount} ch.), suggestion ${better.sourceLabel} (${better.chapterCount} ch.)`);
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
        const preferred = this.opts.getPreferredLanguages();
        for await (const candidates of this._crawlRounds(entry)) {
            // validate in score order: the best match may sit on a broken
            // connector, the runner-up on a perfectly usable source
            const triedSources = new Set<string>();
            for (const candidate of candidates) {
                if (triedSources.has(candidate.sourceId)) {
                    continue;
                }
                triedSources.add(candidate.sourceId);
                if (triedSources.size > MAX_VALIDATIONS_PER_ROUND) {
                    break; // bound the latency: 4 distinct sources max per round
                }
                if (await this._isUsable(entry, candidate, preferred)) {
                    return this._commitMigration(entry, candidate, auto);
                }
            }
        }
        return 'none';
    }

    /** Full usability probe: preferred-language chapters AND a working page
     * list (a connector can list chapters but serve broken pages, as the
     * MangaHere war.jpg grab showed). Failures are logged and swallowed —
     * the hunt simply moves to the next candidate. */
    private async _isUsable(entry: { title: string }, candidate: MigrationTarget, preferred: string[]): Promise<boolean> {
        try {
            const adapter = await this.opts.registry.get(candidate.sourceId);
            if (!adapter) {
                return false;
            }
            const chapters = await withTimeout(
                adapter.getChapters({ id: candidate.mangaId, title: candidate.mangaTitle }),
                VALIDATION_TIMEOUT_MS,
                'chapter list timeout'
            );
            const chapter = chapters.find(item => chapterAllowed(item.language, preferred));
            if (!chapter) {
                console.log(`[failover] "${entry.title}" : ${candidate.sourceLabel} ne sert aucun chapitre dans les langues préférées`);
                return false;
            }
            const pages = await withTimeout(
                adapter.getPages({ id: candidate.mangaId, title: candidate.mangaTitle }, { id: chapter.id, title: chapter.title }),
                PAGE_PROBE_TIMEOUT_MS,
                'page list timeout'
            );
            if (!pages.length) {
                throw new Error('page list is empty');
            }
            return true;
        } catch (error) {
            console.log(`[failover] "${entry.title}" : ${candidate.sourceLabel} inutilisable (${(error as Error).message})`);
            return false;
        }
    }

    /** Store or apply a validated migration target. */
    private async _commitMigration(entry: { id: number; title: string }, target: MigrationTarget, auto: boolean): Promise<'migrated' | 'suggested' | 'none'> {
        const confidence = confidenceFor(target.score);
        if (confidence === 'auto' && auto) {
            const result = await this.opts.store.migrateEntry(entry.id, target);
            console.log(`[failover] "${entry.title}" migré vers ${target.sourceLabel} (${result.kept}/${result.total} chapitres conservés)`);
            return 'migrated';
        }
        this.opts.store.setMigrationSuggestion(entry.id, target);
        const updated = this.opts.store.getEntry(entry.id);
        if (updated?.migrationSuggestion) {
            this.opts.onSuggestion?.(entry, updated.migrationSuggestion, updated.chapterCount);
        }
        return 'suggested';
    }
}
