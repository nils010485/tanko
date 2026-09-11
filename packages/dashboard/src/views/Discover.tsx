/**
 * Discover view: searchable source picker with health statuses, broken-source
 * hiding, manga search and follow (monitor-only or with the whole backlog).
 */

import type { ChapterDto, GlobalSearchStatusDto, MangaDto, SourceDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DuplicateTarget } from '../components/discover/DuplicateDialog.js';
import { ChaptersModal, DuplicateDialog, FollowDialog, GlobalResults, healthDot, MangaResultCard, SourcePicker } from '../components/discover/index.js';
import { IconAlert, IconEyeOff, IconGitHub, IconGlobe, IconRefresh, IconSearch, IconX } from '../components/icons.js';
import { PagePreview } from '../components/PagePreview.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, ErrorDetail, Input, SectionTitle } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api, apiErrorText, RequestError } from '../lib/api.js';
import { useEscapeKey, useUnmounted } from '../lib/hooks.js';
import { hideBrokenSources, recheckAllSources, sourceRank, statusLabel } from '../lib/sources.js';

/** Canonical URL of a search result, when the connector exposes one (some use
 *  the manga id itself as a link). */
function mangaUrlOf(manga: MangaDto): string | undefined {
    return manga.url || (typeof manga.id === 'string' && manga.id.startsWith('http') ? manga.id : undefined);
}

/** Remembered "last used source" for the next visit (see the initial pick below). */
const LAST_SOURCE_KEY = 'tanko.discover.sourceId';
/** Recent committed searches, shown as suggestions under the query input. */
const HISTORY_KEY = 'tanko.discover.history';

function rememberSource(id: string) {
    try {
        localStorage.setItem(LAST_SOURCE_KEY, id);
    } catch {
        // storage unavailable (private mode & co): the pick stays session-only
    }
}

function loadHistory(): string[] {
    try {
        const raw: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
        return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string').slice(0, 10) : [];
    } catch {
        return [];
    }
}

function recordHistory(query: string): string[] {
    const next = [query, ...loadHistory().filter(item => item !== query)].slice(0, 10);
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
        // private mode & co: keep the session list only
    }
    return next;
}

function decodeHashQuery(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return '';
    }
}

/** Keep the query in the hash so a search is shareable (#/discover?q=…) without polluting the history. */
const syncSearchUrl = (query: string) => {
    window.history.replaceState(null, '', query ? `#/discover?q=${encodeURIComponent(query)}` : '#/discover');
};

/** Injected by vite at build time from package.json (see vite.config.ts). */
export default function Discover({
    onAddedToLibrary,
    onOpenSeries,
    sourcesVersion
}: {
    onAddedToLibrary: () => void;
    onOpenSeries?: (id: number) => void;
    sourcesVersion: number;
}) {
    const [sources, setSources] = useState<SourceDto[]>([]);
    const [showHidden, setShowHidden] = useState(false);
    const [comboOpen, setComboOpen] = useState(false);
    const [sourceQuery, setSourceQuery] = useState('');
    const [sourceId, setSourceId] = useState('');
    const [scope, setScope] = useState<'source' | 'global'>('source');
    const [rechecking, setRechecking] = useState(false);
    const [hidingBroken, setHidingBroken] = useState(false);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<MangaDto[] | null>(null);
    /** Truncation signals of the last single-source search (display cap, language drops). */
    const [resultMeta, setResultMeta] = useState<{ total: number; hiddenByLanguage: number } | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [globalStatus, setGlobalStatus] = useState<GlobalSearchStatusDto | null>(null);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalError, setGlobalError] = useState('');
    // lifted (not inside GlobalResults): the component unmounts between searches and must keep its open/collapsed state
    const [showMisses, setShowMisses] = useState(false);
    /** Generation counter for global searches: a run only touches the state while its generation is current (stop, replace, unmount bump it). */
    const globalSeq = useRef(0);
    /** Id of the running global-search job (null = none), cancelled on stop/replace/unmount. */
    const globalJobId = useRef<number | null>(null);
    /** Ignore single-source responses that resolve after a newer search replaced them. */
    const searchSeq = useRef(0);
    /** Aborts the in-flight single-source fetch (stop button, replace, unmount). */
    const searchAbort = useRef<AbortController | null>(null);
    /** Recent committed searches (suggestions) and the query-input focus state. */
    const [history, setHistory] = useState<string[]>(() => loadHistory());
    const [suggestOpen, setSuggestOpen] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchWrapRef = useRef<HTMLDivElement>(null);
    const [selected, setSelected] = useState<MangaDto | null>(null);
    const [chapters, setChapters] = useState<ChapterDto[] | null>(null);
    const [chaptersError, setChaptersError] = useState('');
    const [preview, setPreview] = useState<string[] | null>(null);
    const [previewTitle, setPreviewTitle] = useState('');
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [addingKey, setAddingKey] = useState<string | null>(null);
    const [added, setAdded] = useState<Map<string, number>>(new Map());
    const [followTarget, setFollowTarget] = useState<MangaDto | null>(null);
    const [followCount, setFollowCount] = useState<number | null>(null);
    const [duplicate, setDuplicate] = useState<DuplicateTarget | null>(null);
    const [duplicateBusy, setDuplicateBusy] = useState(false);
    const comboRef = useRef<HTMLDivElement>(null);
    const toast = useToast();
    const { t } = useI18n();
    const unmounted = useUnmounted();
    /** Ignore page responses that resolve after the preview was closed or replaced. */
    const previewSeq = useRef(0);
    const closePreview = () => {
        previewSeq.current++;
        setPreview(null);
    };

    // Ctrl+K / Cmd+K focuses the search input from anywhere in the view
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                searchInputRef.current?.focus();
                setSuggestOpen(true);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const refreshSources = useCallback(async () => {
        const list = await api.sources();
        setSources(list);
        return list;
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only deep-link run; runSearch would retrigger it
    useEffect(() => {
        refreshSources()
            .then(list => {
                const visible = list.filter(source => !source.hidden);
                const lastUsed = localStorage.getItem(LAST_SOURCE_KEY);
                const preferred =
                    visible.find(source => source.id === lastUsed) ||
                    visible.find(source => source.kind === 'native') ||
                    visible.find(source => source.health === 'ok') ||
                    visible[0];
                // deep-link #/discover?q=…: prefill and run once a source is picked
                const hashQuery = /[?&]q=([^&]*)/.exec(window.location.hash);
                const urlQuery = hashQuery ? decodeHashQuery(hashQuery[1] ?? '').trim() : '';
                if (urlQuery) {
                    setQuery(urlQuery);
                    setHistory(recordHistory(urlQuery));
                }
                if (preferred) {
                    setSourceId(preferred.id);
                    if (urlQuery) {
                        void runSearch(urlQuery, preferred.id);
                    }
                }
            })
            .catch((error: unknown) => toast.error((error as Error).message));
    }, [refreshSources, toast]);

    // pre-mark series already in the library: cards show "In library" right away
    // instead of the user discovering it through a 409 on follow
    useEffect(() => {
        void Promise.all([api.library(), api.library(true)])
            .then(([visible, hidden]) => {
                setAdded(current => {
                    const next = new Map(current);
                    for (const entry of [...visible, ...hidden]) {
                        next.set(`${entry.sourceId}:${entry.mangaId}`, entry.id);
                    }
                    return next;
                });
            })
            .catch(() => undefined);
    }, []);

    // rolling health re-checks push sources.updated — refresh the statuses live
    const seenSourcesVersion = useRef(sourcesVersion);
    useEffect(() => {
        if (sourcesVersion === seenSourcesVersion.current) {
            return;
        }
        seenSourcesVersion.current = sourcesVersion;
        void refreshSources().catch(() => undefined);
    }, [sourcesVersion, refreshSources]);
    // close the combobox / the suggestions when clicking outside
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (comboRef.current && !comboRef.current.contains(event.target as Node)) {
                setComboOpen(false);
            }
            if (searchWrapRef.current && !searchWrapRef.current.contains(event.target as Node)) {
                setSuggestOpen(false);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    // stop the global-search polling loop and the server-side fan-out on unmount
    // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; the helpers read refs
    useEffect(() => {
        return () => {
            ++globalSeq.current;
            if (globalJobId.current !== null) {
                cancelGlobalJob();
            }
            searchAbort.current?.abort();
            if (incrementalTimer.current !== null) {
                clearTimeout(incrementalTimer.current);
            }
        };
    }, []);
    // close the chapters / page-preview / follow dialogs with Escape
    const closeModals = useCallback(() => {
        setSelected(null);
        previewSeq.current++;
        setPreview(null);
        setFollowTarget(null);
        setDuplicate(null);
    }, []);
    useEscapeKey(closeModals, selected !== null || preview !== null || previewLoading || followTarget !== null || duplicate !== null);

    const matchingSources = useMemo(() => {
        const base = showHidden ? sources : sources.filter(source => !source.hidden);
        const needle = sourceQuery.trim().toLowerCase();
        const filtered = needle ? base.filter(source => source.label.toLowerCase().includes(needle) || source.id.toLowerCase().includes(needle)) : base;
        return [...filtered].sort((a, b) => sourceRank(a) - sourceRank(b) || a.label.localeCompare(b.label));
    }, [sources, sourceQuery, showHidden]);
    const visibleSources = useMemo(() => matchingSources.slice(0, 40), [matchingSources]);

    const currentSource = sources.find(source => source.id === sourceId);
    const hiddenCount = sources.filter(source => source.hidden).length;
    const brokenCount = sources.filter(source => source.health === 'error' && !source.hidden).length;

    const hideBroken = async () => {
        setHidingBroken(true);
        try {
            await hideBrokenSources({ refreshSources, onError: message => toast.error(message) });
        } finally {
            setHidingBroken(false);
        }
    };
    const recheckAll = async () => {
        setRechecking(true);
        try {
            await recheckAllSources({ refreshSources, cancelled: () => unmounted.current, onError: message => toast.error(message) });
        } finally {
            setRechecking(false);
        }
    };

    /** Cancel the server-side global-search job, if one is running. */
    const cancelGlobalJob = () => {
        const jobId = globalJobId.current;
        if (jobId !== null) {
            globalJobId.current = null;
            void api.cancelGlobalSearch(jobId).catch(() => undefined);
        }
    };

    const runSearch = async (explicitQuery?: string, explicitSourceId?: string) => {
        const searched = (explicitQuery ?? query).trim();
        const searchedSource = explicitSourceId ?? sourceId;
        if (!searchedSource || !searched) return;
        ++globalSeq.current; // a single-source search replaces the global one
        cancelGlobalJob();
        setGlobalSearching(false);
        setGlobalStatus(null);
        setGlobalError('');
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        const seq = ++searchSeq.current;
        setSearching(true);
        setSearchError('');
        setResults(null);
        setResultMeta(null);
        setSelected(null);
        setChapters(null);
        try {
            const { mangas, total, hiddenByLanguage } = await api.search(searchedSource, searched, controller.signal);
            if (seq !== searchSeq.current) return; // a newer search replaced this one
            setResults(mangas);
            setResultMeta({ total, hiddenByLanguage });
        } catch (error) {
            if (seq !== searchSeq.current) return; // aborted or replaced: not an error to show
            setSearchError(apiErrorText(error, t));
        } finally {
            if (seq === searchSeq.current) {
                setSearching(false);
            }
        }
    };

    // global (all visible sources) search: start then poll; sources answer as
    // their cache/endpoint allows and groups render progressively
    const runGlobalSearch = async (explicitQuery?: string) => {
        const searched = (explicitQuery ?? query).trim();
        if (globalSearching || !searched) return;
        const run = ++globalSeq.current;
        searchAbort.current?.abort(); // the global search replaces an in-flight single-source one
        ++searchSeq.current; // …which must not reset the state when its fetch aborts
        setSearching(false);
        setGlobalSearching(true);
        setGlobalError('');
        setGlobalStatus(null);
        setSearchError('');
        setResults(null);
        setResultMeta(null);
        setSelected(null);
        setChapters(null);
        try {
            const { jobId } = await api.searchAll(searched);
            globalJobId.current = jobId;
            if (run !== globalSeq.current) {
                cancelGlobalJob(); // stopped or replaced while starting
                return;
            }
            let pollFailures = 0;
            for (;;) {
                await new Promise(resolve => setTimeout(resolve, 1200));
                if (run !== globalSeq.current) {
                    return;
                }
                let status: GlobalSearchStatusDto | null = null;
                try {
                    status = await api.globalSearch(jobId);
                    pollFailures = 0;
                } catch (error) {
                    // 404 = the server purged the job (restart): keep what we have
                    if (error instanceof RequestError && error.status === 404) {
                        return;
                    }
                    // network hiccup: tolerate a few, then stop and surface it
                    if (++pollFailures >= 3) {
                        setGlobalError(apiErrorText(error, t));
                        return;
                    }
                }
                if (status) {
                    setGlobalStatus(status);
                    if (status.done) {
                        return;
                    }
                }
            }
        } catch (error) {
            if (run === globalSeq.current) {
                setGlobalError(apiErrorText(error, t));
            }
        } finally {
            if (run === globalSeq.current) {
                globalJobId.current = null;
                setGlobalSearching(false);
            }
        }
    };

    const stopGlobalSearch = () => {
        ++globalSeq.current; // the polling loop stops on the next tick without touching the state
        cancelGlobalJob(); // really stop the server-side fan-out, not just the polling
        setGlobalSearching(false);
        // no further poll will run: flag the visible snapshot ourselves
        setGlobalStatus(current => (current ? { ...current, cancelled: true } : current));
    };

    const stopSourceSearch = () => {
        ++searchSeq.current; // the aborted runSearch must not touch the state anymore
        searchAbort.current?.abort();
        searchAbort.current = null;
        setSearching(false);
    };

    // the stop button is shown while either search runs: stop what actually runs,
    // not what the scope toggle currently points at
    const stopSearch = () => {
        if (searching) {
            stopSourceSearch();
        }
        if (globalSearching) {
            stopGlobalSearch();
        }
    };

    const runScopedSearch = scope === 'global' ? runGlobalSearch : runSearch;

    /** Pending debounced incremental search (see onQueryInput). */
    const incrementalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelIncremental = () => {
        if (incrementalTimer.current !== null) {
            clearTimeout(incrementalTimer.current);
            incrementalTimer.current = null;
        }
    };
    // incremental search: typing in "this source" scope auto-searches after a
    // short debounce (explicitQuery keeps the freshest value, not the stale
    // state closure); the global fan-out stays explicit (Enter only)
    const onQueryInput = (value: string) => {
        setQuery(value);
        cancelIncremental();
        if (!value.trim()) {
            syncSearchUrl('');
        }
        if (scope === 'source' && sourceId && value.trim().length >= 2) {
            incrementalTimer.current = setTimeout(() => {
                incrementalTimer.current = null;
                void runSearch(value);
            }, 400);
        }
    };
    const runScopedSearchNow = () => {
        cancelIncremental();
        const committed = query.trim();
        if (committed) {
            setHistory(recordHistory(committed));
            syncSearchUrl(committed);
        }
        runScopedSearch();
    };
    const runFromSuggestion = (value: string) => {
        setSuggestOpen(false);
        setQuery(value);
        cancelIncremental();
        setHistory(recordHistory(value));
        syncSearchUrl(value);
        // the explicit value avoids the stale-state closure in both scopes (runGlobalSearch also reads `query`)
        void (scope === 'global' ? runGlobalSearch(value) : runSearch(value));
    };

    const suggestions = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const list = needle ? history.filter(item => item.toLowerCase().includes(needle) && item.toLowerCase() !== needle) : history;
        return list.slice(0, 6);
    }, [history, query]);

    // honesty note above the results grid: display cap + preferred-language drops
    const truncationNote = useMemo(() => {
        const total = resultMeta?.total ?? 0;
        const hidden = resultMeta?.hiddenByLanguage ?? 0;
        if (!results || results.length === 0 || (total <= results.length && hidden <= 0)) {
            return null;
        }
        return (
            <p className="mb-3 text-xs text-faint">
                {total > results.length ? t('discover.resultsTruncated', { shown: results.length, total }) : null}
                {total > results.length && hidden > 0 ? ' · ' : null}
                {hidden > 0 ? t('discover.resultsHiddenByLanguage', { n: hidden }) : null}
            </p>
        );
    }, [results, resultMeta, t]);

    const openChapters = async (manga: MangaDto) => {
        setSelected(manga);
        setChapters(null);
        setChaptersError('');
        try {
            setChapters(await api.chapters(manga.sourceId, manga.id, manga.title));
        } catch (error) {
            setChapters([]);
            setChaptersError(apiErrorText(error, t));
        }
    };

    const openPreview = async (chapter: ChapterDto) => {
        if (!selected) {
            return;
        }
        const seq = ++previewSeq.current;
        setPreviewTitle(chapter.title);
        setPreview(null);
        setPreviewError('');
        setPreviewLoading(true);
        try {
            const result = await api.pages(selected.sourceId, selected.id, chapter.id, selected.title, chapter.title);
            if (previewSeq.current !== seq) return; // closed or replaced meanwhile
            setPreview(result.pages || []);
        } catch (error) {
            if (previewSeq.current !== seq) return;
            setPreview([]);
            setPreviewError((error as Error).message);
        } finally {
            if (previewSeq.current === seq) {
                setPreviewLoading(false);
            }
        }
    };

    /** Open the follow dialog; the chapter count (when known) sizes the "grab" option.
     *  The ref guards against a slow count resolving after the user switched targets. */
    const followCountFor = useRef<string | null>(null);
    const openFollowChoice = (manga: MangaDto) => {
        const key = `${manga.sourceId}:${manga.id}`;
        followCountFor.current = key;
        setFollowTarget(manga);
        if (selected && `${selected.sourceId}:${selected.id}` === key && chapters) {
            setFollowCount(chapters.length);
            return;
        }
        setFollowCount(null);
        api.chapters(manga.sourceId, manga.id, manga.title)
            .then(list => {
                if (followCountFor.current === key) {
                    setFollowCount(list.length);
                }
            })
            .catch(() => {
                if (followCountFor.current === key) {
                    setFollowCount(null);
                }
            });
    };

    const followManga = async (manga: MangaDto, backlog: 'ignore' | 'grab', force = false) => {
        const key = `${manga.sourceId}:${manga.id}`;
        setAddingKey(key);
        try {
            const result = await api.addToLibrary({
                sourceId: manga.sourceId,
                mangaId: manga.id,
                title: manga.title,
                url: mangaUrlOf(manga),
                thumbnail: manga.thumbnail,
                autoDownload: true,
                backlog,
                force
            });
            setAdded(current => new Map(current).set(key, result.entry.id));
            toast.success(
                backlog === 'grab'
                    ? t('discover.addedGrabbing', { title: manga.title, n: result.queued ?? 0 })
                    : t('discover.addedMonitoring', { title: manga.title })
            );
            onAddedToLibrary();
            setFollowTarget(null);
        } catch (error) {
            if (error instanceof RequestError && error.status === 409 && error.body?.existingEntry) {
                // duplicate guard: offer link-as-alternative vs separate entry
                setDuplicate({ manga, backlog, existing: error.body.existingEntry });
                setFollowTarget(null);
            } else {
                toast.error((error as Error).message);
            }
        } finally {
            setAddingKey(null);
        }
    };

    /** Link the duplicate provenance to the tracked entry instead of creating
     *  a second one: one work, one entry — the failover prefers the link. */
    const linkDuplicate = async () => {
        if (duplicate === null) {
            return;
        }
        const { manga, existing } = duplicate;
        setDuplicateBusy(true);
        try {
            await api.linkSource(existing.id, { sourceId: manga.sourceId, mangaId: manga.id, title: manga.title, url: mangaUrlOf(manga) });
            toast.success(t('discover.duplicateLinked', { title: existing.title, source: manga.title }));
            setDuplicate(null);
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setDuplicateBusy(false);
        }
    };

    /** Force a separate entry: genuinely different works sharing a title. */
    const forceDuplicate = async () => {
        if (duplicate === null) {
            return;
        }
        const { manga, backlog } = duplicate;
        setDuplicateBusy(true);
        try {
            await followManga(manga, backlog, true);
            setDuplicate(null);
        } finally {
            setDuplicateBusy(false);
        }
    };

    /** Queue chapters ad-hoc (single or batch) with feedback; a tracked series
     *  gets its chapter statuses updated server-side. */
    const enqueueChapters = async (manga: MangaDto, list: ChapterDto[]) => {
        try {
            const result = await api.enqueue({
                sourceId: manga.sourceId,
                mangaId: manga.id,
                mangaTitle: manga.title,
                chapters: list.map(chapter => ({ id: chapter.id, title: chapter.title }))
            });
            toast.success(t('discover.chaptersQueued', { n: result.added + result.retried }));
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <div className="flex flex-wrap items-center gap-2">
                        <a
                            href="https://github.com/nils010485/tanko"
                            target="_blank"
                            rel="noreferrer"
                            title={t('discover.githubHint')}
                            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-faint transition-colors hover:bg-surface hover:text-fg"
                        >
                            <IconGitHub size={14} /> v{__APP_VERSION__}
                        </a>
                        <Button variant="ghost" small onClick={hideBroken} loading={hidingBroken} title={t('discover.hideBrokenHint')}>
                            <IconEyeOff size={14} /> {t('discover.hideBroken')} {brokenCount > 0 && `(${brokenCount})`}
                        </Button>
                        <Button variant="ghost" small onClick={recheckAll} loading={rechecking} title={t('discover.recheckAllHint')}>
                            <IconRefresh size={14} /> {t('discover.recheckAll')}
                        </Button>
                    </div>
                }
            >
                {t('discover.title')}
            </SectionTitle>

            {/* Unified search bar: source picker, query, scope toggle and a compact icon button on one row */}
            <Card className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                    <SourcePicker
                        sources={sources}
                        visibleSources={visibleSources}
                        moreCount={matchingSources.length - visibleSources.length}
                        currentSource={currentSource}
                        sourceId={sourceId}
                        sourceQuery={sourceQuery}
                        comboOpen={comboOpen}
                        showHidden={showHidden}
                        hiddenCount={hiddenCount}
                        onToggle={() => {
                            setComboOpen(open => !open);
                            setSourceQuery('');
                        }}
                        onQuery={setSourceQuery}
                        dimmed={scope === 'global'}
                        comboRef={comboRef}
                        onPick={source => {
                            setSourceId(source.id);
                            rememberSource(source.id);
                            setComboOpen(false);
                            setScope('source');
                        }}
                        onToggleShowHidden={() => setShowHidden(value => !value)}
                    />

                    <div className="relative min-w-56 flex-1" ref={searchWrapRef}>
                        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                        <Input
                            className="w-full pl-9"
                            value={query}
                            onChange={onQueryInput}
                            onEnter={runScopedSearchNow}
                            placeholder={t('discover.searchPlaceholder')}
                            inputRef={searchInputRef}
                            onFocus={() => setSuggestOpen(true)}
                        />
                        {suggestOpen && suggestions.length > 0 && (
                            <div
                                role="listbox"
                                aria-label={t('discover.searchHistory')}
                                className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-card shadow-xl shadow-black/40"
                            >
                                {suggestions.map(item => (
                                    <button
                                        key={item}
                                        type="button"
                                        role="option"
                                        aria-selected={false}
                                        onClick={() => runFromSuggestion(item)}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-line"
                                    >
                                        <IconSearch size={13} className="flex-none text-faint" />
                                        <span className="truncate">{item}</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* scope: this source vs everywhere — compact segmented control */}
                    <div className="flex h-10 items-center rounded-lg border border-line bg-canvas/60 p-0.5 text-xs">
                        <button
                            type="button"
                            onClick={() => setScope('source')}
                            title={t('discover.scopeSource')}
                            className={`h-full rounded-md px-2.5 transition-colors ${scope === 'source' ? 'bg-line font-medium text-fg' : 'text-muted hover:text-fg'}`}
                        >
                            {t('discover.scopeSource')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setScope('global')}
                            title={t('discover.scopeGlobal')}
                            className={`flex h-full items-center gap-1.5 rounded-md px-2.5 transition-colors ${scope === 'global' ? 'bg-line font-medium text-fg' : 'text-muted hover:text-fg'}`}
                        >
                            <IconGlobe size={13} /> {t('discover.scopeGlobalShort')}
                        </button>
                    </div>

                    {/* compact icon button — search, or stop while one is running (Enter also runs the search) */}
                    {searching || globalSearching ? (
                        <button
                            type="button"
                            onClick={stopSearch}
                            title={t('discover.searchStop')}
                            className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-red-500/80 text-canvas transition-colors hover:bg-red-500"
                        >
                            <IconX size={16} />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={runScopedSearchNow}
                            disabled={!query.trim() || (scope === 'source' && !sourceId)}
                            title={t('discover.searchButton')}
                            className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-accent text-canvas transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            <IconSearch size={16} />
                        </button>
                    )}
                </div>

                {currentSource && scope === 'source' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-faint">
                        {healthDot(currentSource.health, t)}
                        <span>
                            {statusLabel(currentSource.health, t)}
                            {currentSource.health === 'ok' && currentSource.healthLatencyMs ? ` · ${currentSource.healthLatencyMs} ms` : ''}
                        </span>
                        {(currentSource.tags?.length ?? 0) > 0 && (
                            <span className="ml-2 flex flex-wrap items-center gap-1.5 border-l border-faint pl-4">
                                {currentSource.tags.slice(0, 4).map((tag: string) => (
                                    <Badge key={tag}>{tag}</Badge>
                                ))}
                            </span>
                        )}
                    </div>
                )}
            </Card>

            {searchError && (
                <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">
                    <IconAlert size={16} className="mt-0.5 flex-none text-red-400" />
                    <ErrorDetail error={searchError} className="min-w-0 flex-1" />
                    <button type="button" onClick={() => setSearchError('')} className="ml-auto text-red-400/70 hover:text-red-300">
                        <IconX size={14} />
                    </button>
                </Card>
            )}
            {results === null && !globalStatus && !searching && !globalSearching && !searchError && !globalError && (
                <EmptyState title={t('discover.startTitle')} hint={t('discover.startHint')} icon={<IconSearch size={28} />} />
            )}

            {results && results.length === 0 && <EmptyState title={t('discover.noResults')} hint={t('discover.noResultsHint')} />}
            {results && results.length > 0 && (
                <>
                    {truncationNote}
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {results.map(manga => {
                            const key = `${manga.sourceId}:${manga.id}`;
                            return (
                                <MangaResultCard
                                    key={key}
                                    manga={manga}
                                    sourceLabel={currentSource?.label ?? manga.sourceId}
                                    isAdded={added.has(key)}
                                    isAdding={addingKey === key}
                                    followDisabled={addingKey !== null}
                                    onChapters={openChapters}
                                    onFollow={openFollowChoice}
                                />
                            );
                        })}
                    </div>
                </>
            )}

            {globalError && (
                <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">
                    <IconAlert size={16} className="mt-0.5 flex-none text-red-400" />
                    <ErrorDetail error={globalError} className="min-w-0 flex-1" />
                    <button type="button" onClick={() => setGlobalError('')} className="ml-auto text-red-400/70 hover:text-red-300">
                        <IconX size={14} />
                    </button>
                </Card>
            )}

            {globalStatus && (
                <GlobalResults
                    globalStatus={globalStatus}
                    globalSearching={globalSearching}
                    sources={sources}
                    added={added}
                    addingKey={addingKey}
                    showMisses={showMisses}
                    onToggleMisses={() => setShowMisses(open => !open)}
                    onStop={stopGlobalSearch}
                    onChapters={openChapters}
                    onFollow={openFollowChoice}
                />
            )}

            {selected && (
                <ChaptersModal
                    selected={selected}
                    chapters={chapters}
                    chaptersError={chaptersError}
                    added={added}
                    addingKey={addingKey}
                    onOpenSeries={id => onOpenSeries?.(id)}
                    onClose={() => setSelected(null)}
                    onFollow={openFollowChoice}
                    onPreview={openPreview}
                    onEnqueue={enqueueChapters}
                />
            )}
            <PagePreview
                open={previewLoading || preview !== null}
                title={previewTitle}
                pages={preview}
                loading={previewLoading}
                error={previewError}
                sourceId={selected ? selected.sourceId : sourceId}
                onClose={closePreview}
            />
            {followTarget !== null && (
                <FollowDialog
                    followTarget={followTarget}
                    followCount={followCount}
                    addingKey={addingKey}
                    onFollow={followManga}
                    onClose={() => setFollowTarget(null)}
                />
            )}
            {duplicate !== null && (
                <DuplicateDialog
                    target={duplicate}
                    busy={duplicateBusy}
                    onLink={() => void linkDuplicate()}
                    onForce={() => void forceDuplicate()}
                    onClose={() => setDuplicate(null)}
                />
            )}
        </div>
    );
}
