/**
 * Discover view: searchable source picker with health statuses, broken-source
 * hiding, manga search and follow (monitor-only or with the whole backlog).
 */

import type { ChapterDto, GlobalSearchSourceResultDto, GlobalSearchStatusDto, MangaDto, SourceDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChapterList } from '../components/ChapterList.js';
import { Cover } from '../components/Cover.js';
import {
    IconAlert,
    IconBookmark,
    IconCheck,
    IconChevronDown,
    IconDownload,
    IconEye,
    IconEyeOff,
    IconGlobe,
    IconLibrary,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconSquare,
    IconStar,
    IconX
} from '../components/icons.js';
import { PagePreview } from '../components/PagePreview.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, Input, SectionTitle, Spinner } from '../components/ui.js';
import type { TFunction } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { useEscapeKey } from '../lib/hooks.js';

function healthDot(health: string | undefined, t: TFunction) {
    switch (health) {
        case 'ok':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-emerald-400" title={t('discover.healthOk')} />;
        case 'error':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-red-400" title={t('discover.healthError')} />;
        case 'checking':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-sky-400" title={t('discover.healthChecking')} />;
        default:
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-zinc-600" title={t('discover.healthUntested')} />;
    }
}

function sourceRank(source: SourceDto): number {
    if (source.kind === 'native') return 0;
    if (source.health === 'ok') return 1;
    if (source.health === 'untested') return 2;
    return 3;
}

/** i18n key for each failed global-search status ('ok' groups show counts instead). */
const GLOBAL_STATUS_KEYS: Record<'error' | 'timeout' | 'skipped', Parameters<TFunction>[0]> = {
    error: 'discover.globalSourceError',
    timeout: 'discover.globalSourceTimeout',
    skipped: 'discover.globalSourceSkipped'
};

/** Search result card shared by the single-source and the global results. */
function MangaResultCard({
    manga,
    sourceLabel,
    isAdded,
    isAdding,
    followDisabled,
    onChapters,
    onFollow
}: {
    manga: MangaDto;
    sourceLabel: string;
    isAdded: boolean;
    isAdding: boolean;
    followDisabled: boolean;
    onChapters: (manga: MangaDto) => void;
    onFollow: (manga: MangaDto) => void;
}) {
    const { t } = useI18n();
    return (
        <Card className="flex gap-3 p-3">
            <Cover title={manga.title || '?'} thumbnail={manga.thumbnail} className="h-24 w-16 rounded-md" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={manga.title}>
                    {manga.title}
                </div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">{sourceLabel}</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button small variant="ghost" onClick={() => onChapters(manga)}>
                        {t('discover.chapters')}
                    </Button>
                    <Button small disabled={isAdded || followDisabled} loading={isAdding} onClick={() => onFollow(manga)}>
                        {isAdded ? <IconCheck size={13} /> : <IconPlus size={13} />}
                        {isAdded ? t('discover.followed') : t('discover.follow')}
                    </Button>
                </div>
            </div>
        </Card>
    );
}

export default function Discover({ onAddedToLibrary, onOpenSeries }: { onAddedToLibrary: () => void; onOpenSeries?: (id: number) => void }) {
    const [sources, setSources] = useState<SourceDto[]>([]);
    const [showHidden, setShowHidden] = useState(false);
    const [comboOpen, setComboOpen] = useState(false);
    const [sourceQuery, setSourceQuery] = useState('');
    const [sourceId, setSourceId] = useState('');
    const [scope, setScope] = useState<'source' | 'global'>('source');
    const [rechecking, setRechecking] = useState(false);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<MangaDto[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [globalStatus, setGlobalStatus] = useState<GlobalSearchStatusDto | null>(null);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalError, setGlobalError] = useState('');
    const globalStopped = useRef(false);
    const [showMisses, setShowMisses] = useState(false);
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
    const comboRef = useRef<HTMLDivElement>(null);
    const toast = useToast();
    const { t } = useI18n();

    const refreshSources = useCallback(async () => {
        const list = await api.sources();
        setSources(list);
        return list;
    }, []);

    useEffect(() => {
        refreshSources().then(list => {
            const visible = list.filter(source => !source.hidden);
            const preferred =
                visible.find(source => source.id === 'toonily') ||
                visible.find(source => source.kind === 'native') ||
                visible.find(source => source.health === 'ok') ||
                visible[0];
            if (preferred) {
                setSourceId(preferred.id);
            }
        });
    }, [refreshSources]);

    // close the combobox when clicking outside
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (comboRef.current && !comboRef.current.contains(event.target as Node)) {
                setComboOpen(false);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    // stop the global-search polling loop when the view unmounts
    useEffect(() => {
        globalStopped.current = false;
        return () => {
            globalStopped.current = true;
        };
    }, []);
    // close the chapters / page-preview / follow dialogs with Escape
    const closeModals = useCallback(() => {
        setSelected(null);
        setPreview(null);
        setFollowTarget(null);
    }, []);
    useEscapeKey(closeModals, selected !== null || preview !== null || previewLoading || followTarget !== null);

    const visibleSources = useMemo(() => {
        const base = showHidden ? sources : sources.filter(source => !source.hidden);
        const needle = sourceQuery.trim().toLowerCase();
        const filtered = needle ? base.filter(source => source.label.toLowerCase().includes(needle) || source.id.includes(needle)) : base;
        return [...filtered].sort((a, b) => sourceRank(a) - sourceRank(b) || a.label.localeCompare(b.label)).slice(0, 40);
    }, [sources, sourceQuery, showHidden]);

    const currentSource = sources.find(source => source.id === sourceId);
    const hiddenCount = sources.filter(source => source.hidden).length;
    const brokenCount = sources.filter(source => source.health === 'error' && !source.hidden).length;
    const selectedKey = selected ? `${selected.sourceId}:${selected.id}` : null;

    const hideBroken = async () => {
        await api.hideBroken();
        await refreshSources();
    };

    const recheckAll = async () => {
        setRechecking(true);
        try {
            await api.checkSources();
            // poll while the background probe refreshes statuses
            for (let i = 0; i < 40; i++) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                const list = await refreshSources();
                const stillChecking = list.some(source => source.health === 'checking');
                if (!stillChecking && i > 2) {
                    break;
                }
            }
        } finally {
            setRechecking(false);
        }
    };

    const runSearch = async () => {
        if (!sourceId || !query.trim()) return;
        globalStopped.current = true; // a single-source search replaces the global one
        setGlobalStatus(null);
        setGlobalError('');
        setSearching(true);
        setSearchError('');
        setResults(null);
        setSelected(null);
        setChapters(null);
        try {
            setResults(await api.search(sourceId, query.trim()));
        } catch (error) {
            setSearchError((error as Error).message);
        } finally {
            setSearching(false);
        }
    };

    // global (all visible sources) search: start then poll; sources answer as
    // their cache/endpoint allows and groups render progressively
    // global (all visible sources) search: start then poll; sources answer as
    // their cache/endpoint allows and groups render progressively
    const globalGroups = useMemo(() => {
        if (!globalStatus) {
            return [];
        }
        // preferred-language matches first, then out-of-language hits, then the rest
        const rank = (group: GlobalSearchSourceResultDto) => (group.outOfLanguages ? 1 : group.status === 'ok' ? (group.mangas.length > 0 ? 0 : 2) : 3);
        return [...globalStatus.results].sort((a, b) => rank(a) - rank(b) || b.mangas.length - a.mangas.length || a.sourceLabel.localeCompare(b.sourceLabel));
    }, [globalStatus]);
    // sources with hits render as cards; the rest (empty/failed/skipped)
    // collapses into a single summary row instead of a wall of empty boxes
    const hitGroups = globalGroups.filter(group => group.mangas.length > 0);
    const missGroups = globalGroups.filter(group => group.mangas.length === 0);
    const missEmptyCount = missGroups.filter(group => group.status === 'ok').length;
    const missFailedCount = missGroups.length - missEmptyCount;
    /** Distinct languages among the listed chapters (drives the per-chapter language badge). */
    const chapterLanguages = useMemo(() => new Set((chapters ?? []).map(chapter => chapter.language).filter(Boolean)), [chapters]);
    const runGlobalSearch = async () => {
        if (globalSearching || !query.trim()) return;
        globalStopped.current = false;
        setGlobalSearching(true);
        setGlobalError('');
        setGlobalStatus(null);
        setSearchError('');
        setResults(null);
        setSelected(null);
        setChapters(null);
        try {
            const { jobId } = await api.searchAll(query.trim());
            for (;;) {
                await new Promise(resolve => setTimeout(resolve, 1200));
                if (globalStopped.current) {
                    return;
                }
                // 404 = the server purged the job (restart): keep what we have
                const status = await api.globalSearch(jobId).catch(() => null);
                if (!status) {
                    return;
                }
                setGlobalStatus(status);
                if (status.done) {
                    return;
                }
            }
        } catch (error) {
            setGlobalError((error as Error).message);
        } finally {
            setGlobalSearching(false);
        }
    };

    const stopGlobalSearch = () => {
        globalStopped.current = true;
        setGlobalSearching(false);
    };

    const runScopedSearch = scope === 'global' ? runGlobalSearch : runSearch;

    const openChapters = async (manga: MangaDto) => {
        setSelected(manga);
        setSelected(manga);
        setChapters(null);
        setChaptersError('');
        try {
            setChapters(await api.chapters(manga.sourceId, manga.id, manga.title));
        } catch (error) {
            setChapters([]);
            setChaptersError((error as Error).message);
        }
    };

    const openPreview = async (chapter: ChapterDto) => {
        if (!selected) {
            return;
        }
        setPreviewTitle(chapter.title);
        setPreview(null);
        setPreviewError('');
        setPreviewLoading(true);
        try {
            const result = await api.pages(selected.sourceId, selected.id, chapter.id, selected.title, chapter.title);
            setPreview(result.pages || []);
        } catch (error) {
            setPreview([]);
            setPreviewError((error as Error).message);
        } finally {
            setPreviewLoading(false);
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

    const followManga = async (manga: MangaDto, backlog: 'ignore' | 'grab') => {
        const key = `${manga.sourceId}:${manga.id}`;
        setAddingKey(key);
        try {
            const mangaUrl = manga.url || (typeof manga.id === 'string' && manga.id.startsWith('http') ? manga.id : undefined);
            const result = await api.addToLibrary({
                sourceId: manga.sourceId,
                mangaId: manga.id,
                title: manga.title,
                url: mangaUrl,
                thumbnail: manga.thumbnail,
                autoDownload: true,
                backlog
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
            toast.error((error as Error).message);
        } finally {
            setAddingKey(null);
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
                        <Button variant="ghost" small onClick={hideBroken} title={t('discover.hideBrokenHint')}>
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
                    <div className={`relative ${scope === 'global' ? 'opacity-60' : ''}`} ref={comboRef}>
                        <button
                            type="button"
                            onClick={() => {
                                setComboOpen(open => !open);
                                setSourceQuery('');
                            }}
                            className="flex h-10 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm transition-colors hover:border-zinc-600"
                        >
                            {currentSource ? (
                                <>
                                    {healthDot(currentSource.health, t)}
                                    <span className="max-w-40 truncate font-medium">{currentSource.label}</span>
                                    {currentSource.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                                </>
                            ) : (
                                <span className="text-zinc-500">{t('discover.pickSource')}</span>
                            )}
                            <IconChevronDown size={16} className="text-zinc-500" />
                        </button>

                        {comboOpen && (
                            <div className="absolute z-20 mt-2 w-80 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40">
                                <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
                                    <IconSearch size={14} className="text-zinc-500" />
                                    <input
                                        // biome-ignore lint/a11y/noAutofocus: the combobox search should be focused as soon as it opens
                                        autoFocus
                                        value={sourceQuery}
                                        onChange={event => setSourceQuery(event.target.value)}
                                        placeholder={t('discover.filterSources')}
                                        className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
                                    />
                                </div>
                                <div className="max-h-80 overflow-y-auto">
                                    {visibleSources.map(source => (
                                        <button
                                            type="button"
                                            key={source.id}
                                            onClick={() => {
                                                setSourceId(source.id);
                                                setComboOpen(false);
                                                setScope('source');
                                            }}
                                            className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800 ${source.id === sourceId ? 'bg-zinc-800/70' : ''}`}
                                        >
                                            {healthDot(source.health, t)}
                                            <span className="flex-1 truncate">{source.label}</span>
                                            {source.kind === 'native' && <IconStar size={13} className="text-violet-400" />}
                                            {source.id === sourceId && <IconCheck size={14} className="text-orange-400" />}
                                        </button>
                                    ))}
                                    {visibleSources.length === 0 && (
                                        <div className="px-3 py-4 text-center text-sm text-zinc-500">{t('discover.noSourceMatch')}</div>
                                    )}
                                </div>
                                <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                                    <span>
                                        {showHidden
                                            ? t('discover.sourcesCount', { n: sources.length })
                                            : t('discover.sourcesVisible', { n: sources.length - hiddenCount })}
                                        {hiddenCount > 0 && ` · ${t('discover.hiddenCount', { n: hiddenCount })}`}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setShowHidden(value => !value)}
                                        className="flex items-center gap-1.5 text-zinc-400 transition-colors hover:text-zinc-200"
                                    >
                                        {showHidden ? (
                                            <>
                                                <IconEyeOff size={13} /> {t('discover.hideHidden')}
                                            </>
                                        ) : (
                                            <>
                                                <IconEye size={13} /> {t('discover.showHidden')}
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="relative min-w-56 flex-1">
                        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <Input
                            className="w-full pl-9"
                            value={query}
                            onChange={setQuery}
                            onEnter={runScopedSearch}
                            placeholder={t('discover.searchPlaceholder')}
                        />
                    </div>

                    {/* scope: this source vs everywhere — compact segmented control */}
                    <div className="flex h-10 items-center rounded-lg border border-line bg-zinc-950/60 p-0.5 text-xs">
                        <button
                            type="button"
                            onClick={() => setScope('source')}
                            title={t('discover.scopeSource')}
                            className={`h-full rounded-md px-2.5 transition-colors ${scope === 'source' ? 'bg-zinc-800 font-medium text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                        >
                            {t('discover.scopeSource')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setScope('global')}
                            title={t('discover.scopeGlobal')}
                            className={`flex h-full items-center gap-1.5 rounded-md px-2.5 transition-colors ${scope === 'global' ? 'bg-zinc-800 font-medium text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                        >
                            <IconGlobe size={13} /> {t('discover.scopeGlobalShort')}
                        </button>
                    </div>

                    {/* compact icon button — Enter in the input also runs the search */}
                    <button
                        type="button"
                        onClick={runScopedSearch}
                        disabled={!query.trim() || (scope === 'source' && !sourceId) || searching || globalSearching}
                        title={t('discover.searchButton')}
                        className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-accent text-zinc-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {searching || globalSearching ? <Spinner size={15} /> : <IconSearch size={16} />}
                    </button>
                </div>

                {currentSource && scope === 'source' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        {healthDot(currentSource.health, t)}
                        <span>
                            {currentSource.health === 'ok' && t('discover.statusOk')}
                            {currentSource.health === 'error' && t('discover.statusError')}
                            {currentSource.health === 'checking' && t('discover.statusChecking')}
                            {currentSource.health === 'untested' && t('discover.statusUntested')}
                            {currentSource.health === 'ok' && currentSource.healthLatencyMs ? ` · ${currentSource.healthLatencyMs} ms` : ''}
                        </span>
                        {(currentSource.tags?.length ?? 0) > 0 && (
                            <span className="ml-2 flex flex-wrap items-center gap-1.5 border-l border-zinc-600 pl-4">
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
                    <span>{searchError}</span>
                    <button type="button" onClick={() => setSearchError('')} className="ml-auto text-red-400/70 hover:text-red-300">
                        <IconX size={14} />
                    </button>
                </Card>
            )}

            {results && results.length === 0 && <EmptyState title={t('discover.noResults')} hint={t('discover.noResultsHint')} />}
            {results && results.length > 0 && (
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
            )}

            {globalError && (
                <Card className="flex items-start gap-3 border-red-500/40 bg-red-500/5 p-3 text-sm text-red-300">
                    <IconAlert size={16} className="mt-0.5 flex-none text-red-400" />
                    <span>{globalError}</span>
                    <button type="button" onClick={() => setGlobalError('')} className="ml-auto text-red-400/70 hover:text-red-300">
                        <IconX size={14} />
                    </button>
                </Card>
            )}

            {globalStatus && (
                <div className="space-y-3">
                    <Card className="flex flex-wrap items-center gap-3 p-3 text-sm text-zinc-400">
                        {globalSearching ? (
                            <>
                                <Spinner />
                                <span>{t('discover.globalProgress', { done: globalStatus.completed, total: globalStatus.total })}</span>
                                <span className="ml-auto">
                                    <Button small variant="ghost" onClick={stopGlobalSearch}>
                                        <IconSquare size={13} /> {t('discover.globalStop')}
                                    </Button>
                                </span>
                            </>
                        ) : (
                            <span>{t('discover.globalDone', { total: globalStatus.total })}</span>
                        )}
                    </Card>
                    {hitGroups.map(group => {
                        const source = sources.find(item => item.id === group.sourceId);
                        return (
                            <Card key={group.sourceId} className="p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                    {healthDot(source?.health, t)}
                                    <span className="text-sm font-medium">{group.sourceLabel}</span>
                                    {group.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                                    <span className="text-xs text-zinc-500">
                                        {t('discover.globalResultsCount', { n: group.mangas.length })}
                                        {group.tookMs !== undefined ? ` · ${group.tookMs} ms` : ''}
                                    </span>
                                    {group.outOfLanguages && (
                                        <Badge tone="orange">
                                            <IconGlobe size={12} /> {t('discover.outOfLanguages')}
                                        </Badge>
                                    )}
                                </div>
                                <div className={`mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3${group.outOfLanguages ? ' opacity-60' : ''}`}>
                                    {group.mangas.map(manga => {
                                        const key = `${manga.sourceId}:${manga.id}`;
                                        return (
                                            <MangaResultCard
                                                key={key}
                                                manga={manga}
                                                sourceLabel={group.sourceLabel}
                                                isAdded={added.has(key)}
                                                isAdding={addingKey === key}
                                                followDisabled={addingKey !== null}
                                                onChapters={openChapters}
                                                onFollow={openFollowChoice}
                                            />
                                        );
                                    })}
                                </div>
                            </Card>
                        );
                    })}
                    {missGroups.length > 0 && (
                        <Card className="p-3">
                            <button
                                type="button"
                                onClick={() => setShowMisses(open => !open)}
                                className="flex w-full items-center gap-2 text-left text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                            >
                                <IconChevronDown size={14} className={`flex-none transition-transform ${showMisses ? 'rotate-180' : ''}`} />
                                <span>{t('discover.globalMissSummary', { empty: missEmptyCount, failed: missFailedCount })}</span>
                            </button>
                            {showMisses && (
                                <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                                    {missGroups.map(group => (
                                        <div key={group.sourceId} className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                                            <span
                                                className="min-w-0 flex-1 truncate"
                                                title={group.error ? `${group.sourceLabel} — ${group.error}` : group.sourceLabel}
                                            >
                                                {group.sourceLabel}
                                            </span>
                                            {group.status === 'ok' ? (
                                                <span className="flex-none text-zinc-600">{t('discover.noResults')}</span>
                                            ) : (
                                                <Badge tone={group.status === 'skipped' ? undefined : 'red'}>{t(GLOBAL_STATUS_KEYS[group.status])}</Badge>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </Card>
                    )}
                    {!globalSearching && globalStatus.completed > 0 && hitGroups.length === 0 && (
                        <EmptyState title={t('discover.globalNoResults')} hint={t('discover.globalNoResultsHint')} />
                    )}
                </div>
            )}

            {selected && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the modal also closes with Escape (document listener above)
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                    onClick={e => {
                        if (e.target === e.currentTarget) setSelected(null);
                    }}
                >
                    <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/60">
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                            <div className="min-w-0 truncate text-sm font-semibold" title={selected.title}>
                                {selected.title}
                                {chapters && <span className="ml-1 font-normal text-zinc-500">— {t('discover.chaptersCount', { n: chapters.length })}</span>}
                            </div>
                            <button
                                type="button"
                                className="flex-none rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                                onClick={() => setSelected(null)}
                                title={t('common.close')}
                            >
                                <IconX size={16} />
                            </button>
                        </div>

                        <div className="flex-1 space-y-1 overflow-y-auto p-3 text-sm">
                            {!chapters ? (
                                <div className="flex items-center justify-center gap-2 py-8 text-zinc-500">
                                    <Spinner /> {t('common.loading')}
                                </div>
                            ) : chapters.length === 0 ? (
                                <div className="py-8 text-center text-sm text-zinc-500">
                                    {chaptersError ? <span className="text-red-400">{chaptersError}</span> : t('discover.noChapter')}
                                </div>
                            ) : (
                                <ChapterList
                                    items={chapters.map(chapter => ({
                                        key: chapter.id,
                                        title: chapter.title,
                                        badge: chapterLanguages.size > 1 && chapter.language ? <Badge>{chapter.language}</Badge> : undefined,
                                        node: (
                                            <div className="flex flex-none items-center gap-1">
                                                <Button small variant="ghost" title={t('discover.previewHint')} onClick={() => openPreview(chapter)}>
                                                    <IconEye size={14} />
                                                </Button>
                                                <Button small variant="ghost" onClick={() => enqueueChapters(selected, [chapter])}>
                                                    <span className="flex items-center gap-1">
                                                        <IconDownload size={12} /> DL
                                                    </span>
                                                </Button>
                                            </div>
                                        )
                                    }))}
                                    resetKey={selected.id}
                                />
                            )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 p-3">
                            {selectedKey !== null && (
                                <Button
                                    small
                                    onClick={() => openFollowChoice(selected)}
                                    disabled={added.has(selectedKey) || addingKey !== null}
                                    loading={addingKey === selectedKey}
                                >
                                    {added.has(selectedKey) ? <IconCheck size={13} /> : <IconPlus size={13} />}
                                    {added.has(selectedKey) ? t('discover.inLibrary') : t('discover.followSeries')}
                                </Button>
                            )}
                            <Button small variant="ghost" onClick={() => enqueueChapters(selected, chapters ?? [])} disabled={(chapters ?? []).length === 0}>
                                <IconDownload size={13} /> {t('discover.downloadAll')}
                                {(chapters ?? []).length > 0 ? ` (${chapters?.length})` : ''}
                            </Button>
                            {selectedKey !== null && added.has(selectedKey) && (
                                <Button small variant="ghost" onClick={() => onOpenSeries?.(added.get(selectedKey) ?? 0)}>
                                    <IconLibrary size={13} /> {t('discover.openSeries')}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            )}
            <PagePreview
                open={previewLoading || preview !== null}
                title={previewTitle}
                pages={preview}
                loading={previewLoading}
                error={previewError}
                sourceId={selected ? selected.sourceId : sourceId}
                onClose={() => setPreview(null)}
            />
            {followTarget !== null && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener above)
                <div
                    className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
                    onClick={e => {
                        if (e.target === e.currentTarget) setFollowTarget(null);
                    }}
                >
                    <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50">
                        <div className="text-sm font-semibold text-fg">{t('discover.followChoiceTitle', { title: followTarget.title })}</div>
                        <div className="mt-4 space-y-2">
                            <button
                                type="button"
                                disabled={addingKey !== null}
                                onClick={() => followManga(followTarget, 'ignore')}
                                className="flex w-full items-start gap-3 rounded-lg border border-line bg-zinc-950/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-zinc-900 disabled:opacity-50"
                            >
                                <span className="mt-0.5 text-zinc-400">
                                    <IconBookmark size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-fg">{t('discover.followMonitor')}</span>
                                    <span className="mt-0.5 block text-xs text-muted">{t('discover.followMonitorHint')}</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                disabled={addingKey !== null}
                                onClick={() => followManga(followTarget, 'grab')}
                                className="flex w-full items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-left transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:opacity-50"
                            >
                                <span className="mt-0.5 text-accent-soft">
                                    <IconDownload size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-fg">{t('discover.followGrab')}</span>
                                    <span className="mt-0.5 block text-xs text-muted">
                                        {followCount !== null ? t('discover.followGrabHint', { n: followCount }) : t('discover.followGrabHintUnknown')}
                                    </span>
                                </span>
                            </button>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <Button small variant="ghost" onClick={() => setFollowTarget(null)}>
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
