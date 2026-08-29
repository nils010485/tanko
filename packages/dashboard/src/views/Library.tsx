/**
 * Library view (Sonarr-like): tracked series with follow toggle, new-chapter
 * badges, on-demand check / download-new / remove.
 * Toolbar with rich filters (missing chapters, source/local gap, failing
 * sources, stale checks, paused), sorting, grid/compact/list views and
 * per-user display preferences (persisted in localStorage).
 */

import type { DeadSeriesDto, LibraryBulkAction, LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm.js';
import {
    IconArrowLeftRight,
    IconCheck,
    IconChevronDown,
    IconDownload,
    IconEyeOff,
    IconGrid,
    IconGridSmall,
    IconImport,
    IconLibrary,
    IconList,
    IconRefresh,
    IconSearch,
    IconSliders
} from '../components/icons.js';
import { BulkActionBar } from '../components/library/BulkActionBar.js';
import type { EntryCardHandlers, EntryCardState } from '../components/library/EntryCard.js';
import { EntryGridCard, EntryListRow } from '../components/library/EntryCard.js';
import { BulkRemoveDialog, RemoveEntryDialog } from '../components/library/EntryDialogs.js';
import { MigrationModal } from '../components/MigrationModal.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, SectionTitle, Skeleton } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { enqueueEntryChapters, rematchOutcomeKey } from '../lib/chapters.js';
import {
    type DisplayPrefs,
    FILTER_IDS,
    FILTER_PREDS,
    type FilterId,
    GAP_THRESHOLD,
    gridClassName,
    loadPrefs,
    loadView,
    PREFS_KEY,
    SORTERS,
    type SortKey,
    STALE_DAYS,
    VIEW_KEY,
    type ViewMode
} from '../lib/library-filters.js';

export default function Library({
    library,
    loaded,
    refreshLibrary,
    focusFilter,
    onFocusFilterDone,
    onOpenSeries,
    onNavigateTab
}: {
    library: LibraryEntryDto[];
    loaded: boolean;
    refreshLibrary: () => Promise<void>;
    focusFilter?: string | null;
    onFocusFilterDone?: () => void;
    onOpenSeries?: (id: number) => void;
    onNavigateTab?: (tab: 'discover' | 'import') => void;
}) {
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [expanded, setExpanded] = useState<number | null>(null);
    const [chapters, setChapters] = useState<LibraryChapterDto[] | null>(null);
    const [filter, setFilter] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [pendingRemove, setPendingRemove] = useState<LibraryEntryDto | null>(null);
    const [pendingDisk, setPendingDisk] = useState<LibraryEntryDto | null>(null);
    const [pendingBulkRemove, setPendingBulkRemove] = useState(false);
    const [diskPath, setDiskPath] = useState<string | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [rematchAllBusy, setRematchAllBusy] = useState(false);
    const [rescanBusy, setRescanBusy] = useState(false);
    const [dlAllBusy, setDlAllBusy] = useState(false);
    const [migrationOpen, setMigrationOpen] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [bulkBusy, setBulkBusy] = useState<string | null>(null);
    const [pendingRescan, setPendingRescan] = useState<DeadSeriesDto[] | null>(null);
    const [hiddenList, setHiddenList] = useState<LibraryEntryDto[]>([]);
    const [sort, setSort] = useState<SortKey>('recent');
    const [view, setView] = useState<ViewMode>(loadView);
    const [activeFilters, setActiveFilters] = useState<Set<FilterId>>(new Set());
    const [prefs, setPrefs] = useState<DisplayPrefs>(loadPrefs);
    const [prefsOpen, setPrefsOpen] = useState(false);
    const [menuFor, setMenuFor] = useState<number | null>(null);
    const prefsRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const toast = useToast();
    const { t } = useI18n();

    const refreshHidden = useCallback(async () => {
        try {
            setHiddenList(await api.library(true));
        } catch {
            /* keep the last known list */
        }
    }, []);
    useEffect(() => {
        void refreshHidden();
    }, [refreshHidden]);

    // close the remove dialogs with Escape
    useEffect(() => {
        if (pendingRemove === null && !pendingBulkRemove) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setPendingRemove(null);
                setPendingBulkRemove(false);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pendingRemove, pendingBulkRemove]);

    // close the display popover when clicking outside
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (prefsRef.current && !prefsRef.current.contains(event.target as Node)) {
                setPrefsOpen(false);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    // close a card's overflow menu on click-outside or Escape
    useEffect(() => {
        if (menuFor === null) return;
        const onClick = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuFor(null);
            }
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setMenuFor(null);
        };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuFor]);

    useEffect(() => {
        localStorage.setItem(VIEW_KEY, view);
    }, [view]);
    useEffect(() => {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    }, [prefs]);

    const setBusyFlag = (key: string, value: boolean) => setBusy(current => ({ ...current, [key]: value }));

    const checkEntry = async (entry: LibraryEntryDto) => {
        setBusyFlag(`check-${entry.id}`, true);
        try {
            const result = await api.checkEntry(entry.id);
            toast.info(
                result.newChapters > 0 ? t('library.newChapters', { n: result.newChapters, title: entry.title }) : t('library.upToDate', { title: entry.title })
            );
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag(`check-${entry.id}`, false);
        }
    };

    const downloadNew = async (entry: LibraryEntryDto) => {
        setBusyFlag(`dl-${entry.id}`, true);
        try {
            await api.downloadNew(entry.id);
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag(`dl-${entry.id}`, false);
        }
    };

    /** Queue every already-detected new chapter across visible series (no source re-check). */
    const downloadAllNew = async () => {
        setDlAllBusy(true);
        try {
            const result = await api.downloadAllNew();
            toast.success(t('library.downloadAllNewDone', { queued: result.queued, entries: result.entries }));
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setDlAllBusy(false);
        }
    };

    const toggleSelect = (id: number) =>
        setSelectedIds(current => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });

    const exitSelection = () => {
        setSelecting(false);
        setSelectedIds(new Set());
    };

    /** Long-press (~500 ms, steady pointer) on a card or row enters selection
     *  mode and toggles that entry; moving >10 px or releasing early cancels. */
    const pressState = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
    /** Set when the long-press fired: the release click that follows must be
     *  swallowed — it would land on the re-rendered handlers and undo the
     *  selection that was just toggled. */
    const pressFired = useRef(false);
    const clearPress = () => {
        if (pressState.current) {
            clearTimeout(pressState.current.timer);
            pressState.current = null;
        }
    };
    const longPress = (id: number) => ({
        onPointerDown: (event: React.PointerEvent) => {
            if (selecting) {
                return;
            }
            clearPress();
            pressFired.current = false;
            const { clientX: x, clientY: y } = event;
            pressState.current = {
                timer: setTimeout(() => {
                    pressState.current = null;
                    pressFired.current = true;
                    setSelecting(true);
                    toggleSelect(id);
                }, 500),
                x,
                y
            };
        },
        onPointerMove: (event: React.PointerEvent) => {
            const press = pressState.current;
            if (press && (Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10)) {
                clearPress();
            }
        },
        onPointerUp: clearPress,
        onPointerLeave: clearPress,
        onPointerCancel: clearPress,
        onClickCapture: (event: React.MouseEvent) => {
            if (pressFired.current) {
                pressFired.current = false;
                event.preventDefault();
                event.stopPropagation();
            }
        },
        // touch long-press would open the context menu instead of selecting
        onContextMenu: (event: React.MouseEvent) => {
            if (pressState.current || pressFired.current) {
                event.preventDefault();
            }
        }
    });

    /** Server-side bulk action over the current selection; per-entry failures
     *  are counted by the server and never abort the run. */
    const runBulk = async (action: LibraryBulkAction, disk = false) => {
        const ids = source.filter(entry => selectedIds.has(entry.id)).map(entry => entry.id);
        if (ids.length === 0 || bulkBusy) {
            return;
        }
        setBulkBusy(action);
        try {
            const result = await api.bulkLibrary(ids, action, disk);
            if (action === 'check') {
                toast.info(t('library.bulkCheckDone', { n: result.processed, new: result.newChapters }));
            } else if (action === 'downloadNew') {
                toast.success(t('library.bulkQueuedDone', { n: result.queued, entries: result.processed }));
            } else if (action === 'delete') {
                toast.success(t('library.bulkDeleted', { n: result.deleted }));
            } else {
                toast.success(t('library.bulkDone', { n: result.processed, failed: result.failed }));
            }
            await refreshLibrary();
            if (action === 'hide' || action === 'unhide' || action === 'delete' || showHidden) {
                await refreshHidden();
            }
            exitSelection();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBulkBusy(null);
        }
    };

    const hideEntry = async () => {
        const entry = pendingRemove;
        if (!entry) return;
        setPendingRemove(null);
        try {
            await api.setHidden(entry.id, true);
            toast.success(t('library.hiddenToast', { title: entry.title }));
            await refreshLibrary();
            await refreshHidden();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const askRemoveFromDisk = async () => {
        const entry = pendingRemove;
        if (!entry) return;
        setPendingRemove(null);
        setDiskPath(null);
        setPendingDisk(entry);
        try {
            const result = await api.entryDiskPath(entry.id);
            setDiskPath(result.path);
        } catch {
            /* the confirm dialog falls back to a generic message */
        }
    };

    const confirmRemoveFromDisk = async () => {
        const entry = pendingDisk;
        if (!entry) return;
        setPendingDisk(null);
        try {
            const result = await api.removeFromLibrary(entry.id, true);
            toast.success(
                result.deletedPath
                    ? t('library.removedWithDisk', { title: entry.title, path: result.deletedPath })
                    : t('library.removedNoDisk', { title: entry.title })
            );
            await refreshLibrary();
            await refreshHidden();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const rematchAllFailed = async () => {
        setRematchAllBusy(true);
        try {
            const result = await api.rematchFailed();
            toast.info(result.started ? t('library.rematchStarted', { n: result.count }) : t('library.noFailedToRematch'));
            if (result.started) {
                setTimeout(() => {
                    void refreshLibrary();
                }, 5000);
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRematchAllBusy(false);
        }
    };

    // Disk sync: re-attach local files to their chapters (toast), then dead
    // entries (series folder deleted outside Tanko) are pruned after confirm.
    const rescan = async () => {
        setRescanBusy(true);
        try {
            const result = await api.rescanLibrary();
            if (result.attached > 0) {
                toast.success(t('library.resyncAttached', { n: result.attached, entries: result.entries }));
                await refreshLibrary();
            }
            if (result.dead.length === 0) {
                toast.info(t('library.rescanNone'));
            } else {
                setPendingRescan(result.dead);
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRescanBusy(false);
        }
    };

    const confirmRescan = async () => {
        const dead = pendingRescan ?? [];
        setPendingRescan(null);
        try {
            const { removed } = await api.pruneLibrary(dead.map(entry => entry.id));
            toast.success(t('library.rescanDone', { n: removed }));
            await refreshLibrary();
            await refreshHidden();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const restoreEntry = async (entry: LibraryEntryDto) => {
        try {
            await api.setHidden(entry.id, false);
            toast.success(t('library.restored', { title: entry.title }));
            await refreshLibrary();
            await refreshHidden();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const toggleFollow = async (entry: LibraryEntryDto, value: boolean) => {
        try {
            await api.setAutoDownload(entry.id, value);
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const togglePaused = async (entry: LibraryEntryDto) => {
        try {
            await api.setPaused(entry.id, !entry.paused);
            toast.success(t(entry.paused ? 'library.resumedToast' : 'library.pausedToast', { title: entry.title }));
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const rematch = async (entry: LibraryEntryDto) => {
        setBusyFlag(`rematch-${entry.id}`, true);
        try {
            const result = await api.rematchEntry(entry.id);
            toast.info(t(rematchOutcomeKey(result.outcome), { title: entry.title, source: result.entry?.sourceLabel ?? '' }));
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag(`rematch-${entry.id}`, false);
        }
    };

    const confirmMigration = async (entry: LibraryEntryDto, apply: boolean) => {
        try {
            const result = await api.confirmRematch(entry.id, apply);
            if (apply) {
                toast.success(t('library.migratedKept', { title: entry.title, kept: result.kept ?? 0, total: result.total ?? 0 }));
            }
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const undoMigration = async (entry: LibraryEntryDto) => {
        try {
            await api.rollbackMigration(entry.id);
            toast.success(t('library.migrationUndone', { title: entry.title }));
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const rollbackChapter = async (entry: LibraryEntryDto, chapter: LibraryChapterDto) => {
        try {
            await api.rollbackChapter(entry.id, chapter.chapterId);
            toast.success(t('library.chapterRestored', { chapter: chapter.title }));
            setChapters(await api.entryChapters(entry.id));
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    /** Queue one chapter (download or retry) via the ad-hoc endpoint; the route
     *  resolves the entry so the chapter status follows the job. */
    const downloadChapter = async (entry: LibraryEntryDto, chapter: LibraryChapterDto) => {
        try {
            await enqueueEntryChapters(entry, [chapter]);
            toast.success(t('library.chapterQueued', { chapter: chapter.title }));
            setChapters(await api.entryChapters(entry.id));
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const openChapters = async (entry: LibraryEntryDto) => {
        if (expanded === entry.id) {
            setExpanded(null);
            setChapters(null);
            return;
        }
        setExpanded(entry.id);
        setChapters(null);
        setChapters(await api.entryChapters(entry.id));
    };

    const toggleFilter = (id: FilterId) =>
        setActiveFilters(current => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });

    const filterLabel = (id: FilterId): string => {
        switch (id) {
            case 'new':
                return t('library.filterNew');
            case 'missing':
                return t('library.filterMissing');
            case 'gap':
                return t('library.filterGap', { n: GAP_THRESHOLD });
            case 'failing':
                return t('library.filterFailing');
            case 'stale':
                return t('library.filterStale', { n: STALE_DAYS });
            case 'migration':
                return t('library.filterMigration');
            case 'paused':
                return t('library.filterPaused');
        }
    };

    const source = showHidden ? hiddenList : library;
    const filtered = useMemo(() => {
        const active = FILTER_IDS.filter(id => activeFilters.has(id));
        return source
            .filter(entry => entry.title.toLowerCase().includes(filter.toLowerCase()))
            .filter(entry => active.length === 0 || active.some(id => FILTER_PREDS[id](entry)))
            .sort(SORTERS[sort]);
    }, [source, filter, activeFilters, sort]);
    const failingCount = source.filter(entry => (entry.checkFailures ?? 0) > 0).length;
    const pendingMigrations = library.filter(entry => entry.migrationSuggestion);
    const totalNew = library.reduce((sum, entry) => sum + entry.newCount, 0);
    // bulk actions only process the selection that is visible in the current list (visible vs hidden)
    const selectedInView = selecting ? source.filter(entry => selectedIds.has(entry.id)).length : 0;
    const allInViewSelected = selecting && filtered.length > 0 && filtered.every(entry => selectedIds.has(entry.id));
    const toggleSelectAll = () =>
        setSelectedIds(current => {
            const next = new Set(current);
            for (const entry of filtered) {
                if (allInViewSelected) {
                    next.delete(entry.id);
                } else {
                    next.add(entry.id);
                }
            }
            return next;
        });

    // clicking the sidebar "new" badge focuses the library on new chapters (consumed once)
    useEffect(() => {
        if (focusFilter !== 'new') return;
        setActiveFilters(new Set<FilterId>(['new']));
        onFocusFilterDone?.();
    }, [focusFilter, onFocusFilterDone]);

    const viewButton = (mode: ViewMode, icon: React.ReactNode, label: string) => (
        <button
            key={mode}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => setView(mode)}
            className={`px-2.5 py-1.5 transition-colors first:rounded-l-lg last:rounded-r-lg ${view === mode ? 'bg-zinc-800 text-fg' : 'text-muted hover:bg-zinc-800/60'}`}
        >
            {icon}
        </button>
    );

    const prefRow = (key: keyof DisplayPrefs, label: string) => (
        <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm">
            <span>{label}</span>
            <input
                type="checkbox"
                checked={prefs[key]}
                onChange={event => setPrefs(current => ({ ...current, [key]: event.target.checked }))}
                className="accent-orange-500"
            />
        </label>
    );

    const cardState: EntryCardState = { busy, expandedId: expanded, chapters, selecting, selectedIds, showHidden, view, prefs, menuFor };
    const cardHandlers: EntryCardHandlers = {
        onCheck: checkEntry,
        onDownloadNew: downloadNew,
        onToggleChapters: openChapters,
        onRematch: rematch,
        onTogglePaused: togglePaused,
        onUndoMigration: undoMigration,
        onRestore: restoreEntry,
        onRemove: setPendingRemove,
        onToggleFollow: toggleFollow,
        onConfirmMigration: confirmMigration,
        onOpenSeries: id => onOpenSeries?.(id),
        onDownloadChapter: downloadChapter,
        onRollbackChapter: rollbackChapter,
        onToggleSelect: toggleSelect,
        onMenuFor: setMenuFor
    };

    return (
        <div className={`space-y-6 ${prefs.actions ? '' : 'library-actions-hover'}`}>
            <SectionTitle
                right={
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                        <Button small onClick={downloadAllNew} loading={dlAllBusy} disabled={totalNew === 0} title={t('library.downloadAllNewHint')}>
                            <IconDownload size={13} /> {t('library.downloadAllNew')}
                            {totalNew > 0 && <span className="rounded-full bg-zinc-950/15 px-1.5 text-xs font-semibold text-zinc-950">{totalNew}</span>}
                        </Button>
                        {failingCount > 0 && (
                            <Button small variant="ghost" onClick={rematchAllFailed} loading={rematchAllBusy} title={t('library.rematchFailedHint')}>
                                <IconSearch size={13} /> {t('library.rematchFailed', { n: failingCount })}
                            </Button>
                        )}
                        {pendingMigrations.length > 0 && (
                            <Button small variant="ghost" onClick={() => setMigrationOpen(true)} title={t('library.migrationProcessHint')}>
                                <IconArrowLeftRight size={13} /> {t('library.migrationProcess', { n: pendingMigrations.length })}
                            </Button>
                        )}
                        <Button small variant={showHidden ? 'primary' : 'ghost'} onClick={() => setShowHidden(current => !current)}>
                            <IconEyeOff size={13} /> {t('library.hidden')}
                            {hiddenList.length > 0 ? ` (${hiddenList.length})` : ''}
                        </Button>
                        <Button small variant="ghost" onClick={rescan} loading={rescanBusy} title={t('library.rescanHint')}>
                            <IconRefresh size={13} /> {t('library.rescan')}
                        </Button>
                        {view === 'list' && (
                            <Button
                                small
                                variant={selecting ? 'primary' : 'ghost'}
                                onClick={() => (selecting ? exitSelection() : setSelecting(true))}
                                title={t('library.selectionHint')}
                            >
                                <IconCheck size={13} /> {t('library.selection')}
                            </Button>
                        )}
                    </div>
                }
            >
                {t('library.title')}
                {showHidden && <Badge tone="purple">{t('library.hiddenSeries')}</Badge>}
            </SectionTitle>

            <div className="rounded-xl border border-line bg-surface/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-40 flex-1">
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
                            <IconSearch size={14} />
                        </span>
                        <input
                            value={filter}
                            onChange={event => setFilter(event.target.value)}
                            placeholder={t('library.filter')}
                            className="w-full rounded-lg border border-line bg-canvas py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent"
                        />
                    </div>
                    <select
                        value={sort}
                        onChange={event => setSort(event.target.value as SortKey)}
                        className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                    >
                        <option value="recent">{t('library.sortRecent')}</option>
                        <option value="title">{t('library.sortTitle')}</option>
                        <option value="progress">{t('library.sortProgress')}</option>
                        <option value="new">{t('library.sortNew')}</option>
                        <option value="gap">{t('library.sortGap')}</option>
                    </select>
                    <div className="flex rounded-lg border border-line">
                        {viewButton('grid', <IconGrid size={14} />, t('library.viewGrid'))}
                        {viewButton('grid-compact', <IconGridSmall size={14} />, t('library.viewGridCompact'))}
                        {viewButton('list', <IconList size={14} />, t('library.viewList'))}
                    </div>
                    <div className="relative" ref={prefsRef}>
                        <Button small variant="ghost" title={t('library.display')} onClick={() => setPrefsOpen(current => !current)}>
                            <IconSliders size={13} /> {t('library.display')}
                        </Button>
                        {prefsOpen && (
                            <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-line bg-surface p-3 shadow-xl shadow-black/60">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{t('library.displayVisible')}</div>
                                {prefRow('progress', t('library.showProgress'))}
                                {prefRow('date', t('library.showDate'))}
                                {prefRow('source', t('library.showSource'))}
                                {prefRow('missing', t('library.showMissing'))}
                                <div className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-faint">{t('library.actionsGroup')}</div>
                                {prefRow('actions', t('library.showActions'))}
                            </div>
                        )}
                    </div>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
                    {/* mobile: chips collapse behind a toggle — active ones stay visible */}
                    <button
                        type="button"
                        onClick={() => setFiltersOpen(current => !current)}
                        aria-expanded={filtersOpen}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-muted transition-colors hover:border-zinc-600 lg:hidden"
                    >
                        <IconChevronDown size={12} className={`flex-none transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
                        {t('library.filtersToggle')}
                        {activeFilters.size > 0 && <span className="rounded-full bg-accent/10 px-1 text-[10px] text-accent-soft">{activeFilters.size}</span>}
                    </button>
                    {FILTER_IDS.map(id => {
                        const on = activeFilters.has(id);
                        const count = source.filter(FILTER_PREDS[id]).length;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => toggleFilter(id)}
                                className={`items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                    on
                                        ? 'inline-flex border-accent/50 bg-accent/10 text-accent-soft'
                                        : `border-line bg-canvas text-muted hover:border-zinc-600 ${filtersOpen ? 'inline-flex' : 'hidden lg:inline-flex'}`
                                }`}
                            >
                                {filterLabel(id)}
                                <span className={`rounded-full px-1 text-[10px] ${on ? 'text-accent-soft' : 'text-faint'}`}>{count}</span>
                            </button>
                        );
                    })}
                    {activeFilters.size > 0 && (
                        <button
                            type="button"
                            onClick={() => setActiveFilters(new Set())}
                            className="px-2 py-1 text-xs text-faint transition-colors hover:text-fg"
                        >
                            ✕ {t('library.filtersClear')}
                        </button>
                    )}
                </div>
            </div>

            {selecting && (
                <BulkActionBar
                    selectedInView={selectedInView}
                    allInViewSelected={allInViewSelected}
                    canSelectAll={filtered.length > 0}
                    showHidden={showHidden}
                    bulkBusy={bulkBusy}
                    onToggleSelectAll={toggleSelectAll}
                    onRunBulk={runBulk}
                    onRemoveSelected={() => setPendingBulkRemove(true)}
                    onExit={exitSelection}
                />
            )}

            {!loaded && view === 'list' && (
                <div className="space-y-2">
                    {['sk-a', 'sk-b', 'sk-c', 'sk-d'].map(key => (
                        <Card key={key} className="flex gap-3 p-2.5">
                            <Skeleton className="h-16 w-11 rounded-md" />
                            <div className="flex-1 space-y-2.5 py-1">
                                <Skeleton className="h-4 w-1/3" />
                                <Skeleton className="h-3 w-1/2" />
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            {!loaded && view !== 'list' && (
                <div className={gridClassName(view)}>
                    {['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e', 'sk-f', 'sk-g', 'sk-h', 'sk-i', 'sk-j'].map(key => (
                        <Card key={key} className="overflow-hidden">
                            <Skeleton className="aspect-[2/3] w-full" />
                            <div className="space-y-2.5 p-3">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-3 w-1/2" />
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            {loaded && filtered.length === 0 && source.length === 0 && !showHidden && (
                <EmptyState title={t('library.noSeries')} hint={t('library.noSeriesHint')} icon={<IconLibrary size={28} />}>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button small onClick={() => onNavigateTab?.('discover')}>
                            <IconSearch size={13} /> {t('library.emptyDiscoverCta')}
                        </Button>
                        <Button small variant="ghost" onClick={() => onNavigateTab?.('import')}>
                            <IconImport size={13} /> {t('library.emptyImportCta')}
                        </Button>
                    </div>
                </EmptyState>
            )}
            {loaded && filtered.length === 0 && source.length === 0 && showHidden && (
                <EmptyState title={t('library.noHidden')} hint={t('library.noHiddenHint')} icon={<IconEyeOff size={28} />} />
            )}
            {loaded && filtered.length === 0 && source.length > 0 && <EmptyState title={t('library.noMatch')} icon={<IconSearch size={28} />} />}

            {loaded && filtered.length > 0 && view === 'list' && (
                <div className="space-y-2">
                    {filtered.map(entry => (
                        <EntryListRow key={entry.id} entry={entry} state={cardState} handlers={cardHandlers} menuRef={menuRef} longPress={longPress} />
                    ))}
                </div>
            )}
            {loaded && filtered.length > 0 && view !== 'list' && (
                <div className={gridClassName(view)}>
                    {filtered.map(entry => (
                        <EntryGridCard key={entry.id} entry={entry} state={cardState} handlers={cardHandlers} menuRef={menuRef} longPress={longPress} />
                    ))}
                </div>
            )}

            {pendingRemove !== null && (
                <RemoveEntryDialog entry={pendingRemove} onHide={hideEntry} onAskRemoveFromDisk={askRemoveFromDisk} onClose={() => setPendingRemove(null)} />
            )}

            {pendingBulkRemove && selecting && (
                <BulkRemoveDialog
                    count={selectedInView}
                    onDelete={disk => {
                        setPendingBulkRemove(false);
                        void runBulk('delete', disk);
                    }}
                    onClose={() => setPendingBulkRemove(false)}
                />
            )}

            <ConfirmDialog
                open={pendingDisk !== null}
                title={t('library.deleteTitle', { title: pendingDisk?.title ?? '' })}
                body={
                    diskPath ? (
                        <>
                            {t('library.deleteBodyPath')}
                            <code className="mt-1 block break-all rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-300">{diskPath}</code>
                        </>
                    ) : (
                        t('library.deleteBodyGeneric')
                    )
                }
                confirmLabel={t('library.deleteEverything')}
                onConfirm={confirmRemoveFromDisk}
                onCancel={() => setPendingDisk(null)}
            />
            <ConfirmDialog
                open={pendingRescan !== null}
                title={t('library.rescanTitle', { n: pendingRescan?.length ?? 0 })}
                body={
                    <ul className="max-h-60 space-y-1 overflow-y-auto text-sm">
                        {(pendingRescan ?? []).map(entry => (
                            <li key={entry.id} className="flex items-baseline justify-between gap-3">
                                <span className="truncate font-medium">{entry.title}</span>
                                <code className="truncate text-xs text-zinc-500" title={entry.directory ?? undefined}>
                                    {entry.directory}
                                </code>
                            </li>
                        ))}
                    </ul>
                }
                confirmLabel={t('library.rescanConfirm')}
                onConfirm={confirmRescan}
                onCancel={() => setPendingRescan(null)}
            />
            <MigrationModal open={migrationOpen} entries={pendingMigrations} onClose={() => setMigrationOpen(false)} onChanged={refreshLibrary} />
        </div>
    );
}
