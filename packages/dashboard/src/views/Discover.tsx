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
import { Badge, Button, Card, EmptyState, ErrorDetail, Input, SectionTitle, Spinner } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api, RequestError } from '../lib/api.js';
import { useEscapeKey } from '../lib/hooks.js';
import { sourceRank, statusLabel } from '../lib/sources.js';

/** Canonical URL of a search result, when the connector exposes one (some use
 *  the manga id itself as a link). */
function mangaUrlOf(manga: MangaDto): string | undefined {
    return manga.url || (typeof manga.id === 'string' && manga.id.startsWith('http') ? manga.id : undefined);
}

/** Injected by vite at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;
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
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [globalStatus, setGlobalStatus] = useState<GlobalSearchStatusDto | null>(null);
    const [globalSearching, setGlobalSearching] = useState(false);
    const [globalError, setGlobalError] = useState('');
    // lifted (not inside GlobalResults): the component unmounts between searches and must keep its open/collapsed state
    const [showMisses, setShowMisses] = useState(false);
    const globalStopped = useRef(false);
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
    // rolling health re-checks push sources.updated — refresh the statuses live
    const seenSourcesVersion = useRef(sourcesVersion);
    useEffect(() => {
        if (sourcesVersion === seenSourcesVersion.current) {
            return;
        }
        seenSourcesVersion.current = sourcesVersion;
        void refreshSources().catch(() => undefined);
    }, [sourcesVersion, refreshSources]);

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
        setDuplicate(null);
    }, []);
    useEscapeKey(closeModals, selected !== null || preview !== null || previewLoading || followTarget !== null || duplicate !== null);

    const visibleSources = useMemo(() => {
        const base = showHidden ? sources : sources.filter(source => !source.hidden);
        const needle = sourceQuery.trim().toLowerCase();
        const filtered = needle ? base.filter(source => source.label.toLowerCase().includes(needle) || source.id.toLowerCase().includes(needle)) : base;
        return [...filtered].sort((a, b) => sourceRank(a) - sourceRank(b) || a.label.localeCompare(b.label)).slice(0, 40);
    }, [sources, sourceQuery, showHidden]);

    const currentSource = sources.find(source => source.id === sourceId);
    const hiddenCount = sources.filter(source => source.hidden).length;
    const brokenCount = sources.filter(source => source.health === 'error' && !source.hidden).length;

    const hideBroken = async () => {
        setHidingBroken(true);
        try {
            await api.hideBroken();
            await refreshSources();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setHidingBroken(false);
        }
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
                        currentSource={currentSource}
                        sourceId={sourceId}
                        sourceQuery={sourceQuery}
                        comboOpen={comboOpen}
                        showHidden={showHidden}
                        hiddenCount={hiddenCount}
                        dimmed={scope === 'global'}
                        comboRef={comboRef}
                        onToggle={() => {
                            setComboOpen(open => !open);
                            setSourceQuery('');
                        }}
                        onQuery={setSourceQuery}
                        onPick={source => {
                            setSourceId(source.id);
                            setComboOpen(false);
                            setScope('source');
                        }}
                        onToggleShowHidden={() => setShowHidden(value => !value)}
                    />

                    <div className="relative min-w-56 flex-1">
                        <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                        <Input
                            className="w-full pl-9"
                            value={query}
                            onChange={setQuery}
                            onEnter={runScopedSearch}
                            placeholder={t('discover.searchPlaceholder')}
                        />
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

                    {/* compact icon button — Enter in the input also runs the search */}
                    <button
                        type="button"
                        onClick={runScopedSearch}
                        disabled={!query.trim() || (scope === 'source' && !sourceId) || searching || globalSearching}
                        title={t('discover.searchButton')}
                        className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-accent text-canvas transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {searching || globalSearching ? <Spinner size={15} /> : <IconSearch size={16} />}
                    </button>
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
                onClose={() => setPreview(null)}
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
