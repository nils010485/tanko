/**
 * Discover view: searchable source picker with health statuses, broken-source
 * hiding, manga search and library add.
 */

import type { ChapterDto, MangaDto, SourceDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cover } from '../components/Cover.js';
import {
    IconAlert,
    IconCheck,
    IconChevronDown,
    IconDownload,
    IconEye,
    IconEyeOff,
    IconPlus,
    IconRefresh,
    IconSearch,
    IconStar,
    IconX
} from '../components/icons.js';
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

export default function Discover({ onAddedToLibrary }: { onAddedToLibrary: () => void }) {
    const [sources, setSources] = useState<SourceDto[]>([]);
    const [showHidden, setShowHidden] = useState(false);
    const [comboOpen, setComboOpen] = useState(false);
    const [sourceQuery, setSourceQuery] = useState('');
    const [sourceId, setSourceId] = useState('');
    const [rechecking, setRechecking] = useState(false);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<MangaDto[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [selected, setSelected] = useState<MangaDto | null>(null);
    const [chapters, setChapters] = useState<ChapterDto[] | null>(null);
    const [chaptersError, setChaptersError] = useState('');
    const [preview, setPreview] = useState<string[] | null>(null);
    const [previewTitle, setPreviewTitle] = useState('');
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [adding, setAdding] = useState(false);
    const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
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

    // close the chapters / page-preview modals with Escape
    const closeModals = useCallback(() => {
        setSelected(null);
        setPreview(null);
    }, []);
    useEscapeKey(closeModals, selected !== null || preview !== null || previewLoading);

    const visibleSources = useMemo(() => {
        const base = showHidden ? sources : sources.filter(source => !source.hidden);
        const needle = sourceQuery.trim().toLowerCase();
        const filtered = needle ? base.filter(source => source.label.toLowerCase().includes(needle) || source.id.includes(needle)) : base;
        return [...filtered].sort((a, b) => sourceRank(a) - sourceRank(b) || a.label.localeCompare(b.label)).slice(0, 40);
    }, [sources, sourceQuery, showHidden]);

    const currentSource = sources.find(source => source.id === sourceId);
    const hiddenCount = sources.filter(source => source.hidden).length;
    const brokenCount = sources.filter(source => source.health === 'error' && !source.hidden).length;

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

    const openChapters = async (manga: MangaDto) => {
        setSelected(manga);
        setChapters(null);
        setChaptersError('');
        try {
            setChapters(await api.chapters(sourceId, manga.id, manga.title));
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
            const result = await api.pages(sourceId, selected.id, chapter.id, selected.title, chapter.title);
            setPreview(result.pages || []);
        } catch (error) {
            setPreview([]);
            setPreviewError((error as Error).message);
        } finally {
            setPreviewLoading(false);
        }
    };

    const addToLibrary = async (manga: MangaDto) => {
        setAdding(true);
        try {
            const mangaUrl = manga.url || (typeof manga.id === 'string' && manga.id.startsWith('http') ? manga.id : undefined);
            await api.addToLibrary({ sourceId, mangaId: manga.id, title: manga.title, url: mangaUrl, thumbnail: manga.thumbnail, autoDownload: true });
            setAddedIds(current => new Set(current).add(`${sourceId}:${manga.id}`));
            toast.success(t('discover.addedToLibrary', { title: manga.title }));
            onAddedToLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setAdding(false);
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

            {/* Source picker */}
            <Card className="p-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{t('discover.source')}</div>
                <div className="relative" ref={comboRef}>
                    <button
                        type="button"
                        onClick={() => {
                            setComboOpen(open => !open);
                            setSourceQuery('');
                        }}
                        className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left text-sm transition-colors hover:border-zinc-600"
                    >
                        {currentSource ? (
                            <>
                                {healthDot(currentSource.health, t)}
                                <span className="flex-1 truncate font-medium">{currentSource.label}</span>
                                {currentSource.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                            </>
                        ) : (
                            <span className="flex-1 text-zinc-500">{t('discover.pickSource')}</span>
                        )}
                        <IconChevronDown size={16} className="text-zinc-500" />
                    </button>

                    {comboOpen && (
                        <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40">
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

                {currentSource && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <Badge tone={currentSource.kind === 'native' ? 'purple' : 'zinc'}>{currentSource.kind}</Badge>
                        {currentSource.health === 'ok' && (
                            <Badge tone="green">
                                {t('discover.statusOk')}
                                {currentSource.healthLatencyMs ? ` · ${currentSource.healthLatencyMs} ms` : ''}
                            </Badge>
                        )}
                        {currentSource.health === 'error' && <Badge tone="red">{t('discover.statusError')}</Badge>}
                        {currentSource.health === 'checking' && <Badge tone="blue">{t('discover.statusChecking')}</Badge>}
                        {currentSource.health === 'untested' && <Badge>{t('discover.statusUntested')}</Badge>}
                        {currentSource.tags?.slice(0, 4).map((tag: string) => (
                            <Badge key={tag}>{tag}</Badge>
                        ))}
                    </div>
                )}
            </Card>

            {/* Search */}
            <Card className="p-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{t('discover.search')}</div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-64 flex-1">
                        <Input className="w-full" value={query} onChange={setQuery} placeholder={t('discover.searchPlaceholder')} />
                    </div>
                    <Button onClick={runSearch} disabled={!query.trim() || !sourceId} loading={searching}>
                        <IconSearch size={15} /> {t('discover.searchButton')}
                    </Button>
                </div>
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
                        const key = `${sourceId}:${manga.id}`;
                        const isAdded = addedIds.has(key);
                        return (
                            <Card key={key} className="flex gap-3 p-3">
                                <Cover title={manga.title || '?'} thumbnail={manga.thumbnail} className="h-24 w-16 rounded-md" />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium" title={manga.title}>
                                        {manga.title}
                                    </div>
                                    <div className="mt-0.5 truncate text-xs text-zinc-500">{currentSource?.label}</div>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        <Button small variant="ghost" onClick={() => openChapters(manga)}>
                                            {t('discover.chapters')}
                                        </Button>
                                        <Button small disabled={isAdded} loading={adding && !isAdded} onClick={() => addToLibrary(manga)}>
                                            {isAdded ? <IconCheck size={13} /> : <IconPlus size={13} />}
                                            {isAdded ? t('discover.followed') : t('discover.follow')}
                                        </Button>
                                    </div>
                                </div>
                            </Card>
                        );
                    })}
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
                                chapters.slice(0, 200).map(chapter => (
                                    <div key={chapter.id} className="flex items-center justify-between gap-2 rounded-md bg-zinc-900/60 px-3 py-1.5">
                                        <span className="min-w-0 flex-1 truncate text-zinc-300">{chapter.title}</span>
                                        <div className="flex flex-none items-center gap-1">
                                            <Button small variant="ghost" title={t('discover.previewHint')} onClick={() => openPreview(chapter)}>
                                                <IconEye size={14} />
                                            </Button>
                                            <Button
                                                small
                                                variant="ghost"
                                                onClick={() =>
                                                    api.enqueue({
                                                        sourceId,
                                                        mangaId: selected.id,
                                                        mangaTitle: selected.title,
                                                        chapters: [{ id: chapter.id, title: chapter.title }]
                                                    })
                                                }
                                            >
                                                <span className="flex items-center gap-1">
                                                    <IconDownload size={12} /> DL
                                                </span>
                                            </Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>

                        <div className="border-t border-zinc-800 p-3">
                            <Button
                                small
                                onClick={() => addToLibrary(selected)}
                                disabled={addedIds.has(`${sourceId}:${selected.id}`)}
                                loading={adding && !addedIds.has(`${sourceId}:${selected.id}`)}
                            >
                                {addedIds.has(`${sourceId}:${selected.id}`) ? <IconCheck size={13} /> : <IconPlus size={13} />}
                                {addedIds.has(`${sourceId}:${selected.id}`) ? t('discover.inLibrary') : t('discover.followSeries')}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
            {previewLoading || (preview !== null && previewTitle) ? null : null}
            {(previewLoading || preview !== null) && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the modal also closes with Escape (document listener above)
                <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
                    onClick={e => {
                        if (e.target === e.currentTarget) setPreview(null);
                    }}
                >
                    <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
                        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
                            <div className="min-w-0 truncate text-sm font-semibold" title={previewTitle}>
                                {t('discover.previewTitle', { title: previewTitle })}
                                {preview && <span className="ml-1 font-normal text-zinc-500">({t('discover.pagesCount', { n: preview.length })})</span>}
                            </div>
                            <button
                                type="button"
                                className="flex-none rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                                onClick={() => setPreview(null)}
                                title={t('common.close')}
                            >
                                <IconX size={16} />
                            </button>
                        </div>
                        <div className="flex-1 space-y-2 overflow-y-auto bg-zinc-900/40 p-3">
                            {previewLoading ? (
                                <div className="flex items-center justify-center gap-2 py-10 text-zinc-500">
                                    <Spinner /> {t('discover.loadingPages')}
                                </div>
                            ) : previewError ? (
                                <div className="py-10 text-center text-sm text-red-400">{previewError}</div>
                            ) : (preview || []).length === 0 ? (
                                <div className="py-10 text-center text-sm text-zinc-500">{t('discover.noPages')}</div>
                            ) : (
                                (preview || []).map((url, i) => (
                                    <img
                                        key={url}
                                        src={`/api/sources/${encodeURIComponent(sourceId)}/page-image?url=${encodeURIComponent(url)}`}
                                        alt={`page ${i + 1}`}
                                        loading="lazy"
                                        className="mx-auto w-full max-w-xl rounded-md border border-zinc-800"
                                    />
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
