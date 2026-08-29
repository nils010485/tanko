/**
 * Library view (Sonarr-like): tracked series with follow toggle, new-chapter
 * badges, on-demand check / download-new / remove.
 * Toolbar with rich filters (missing chapters, source/local gap, failing
 * sources, stale checks, paused), sorting, grid/compact/list views and
 * per-user display preferences (persisted in localStorage).
 */

import type { DeadSeriesDto, LibraryBulkAction, LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChapterStatusBadge } from '../components/ChapterList.js';
import { Cover } from '../components/Cover.js';
import { ConfirmDialog } from '../components/confirm.js';
import {
    IconArrowLeftRight,
    IconBookmark,
    IconBookmarkFilled,
    IconCheck,
    IconDots,
    IconDownload,
    IconEyeOff,
    IconFolder,
    IconGrid,
    IconGridSmall,
    IconLibrary,
    IconList,
    IconPause,
    IconPlay,
    IconRefresh,
    IconSearch,
    IconSliders,
    IconTrash,
    IconUndo,
    IconX
} from '../components/icons.js';
import { MigrationModal } from '../components/MigrationModal.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, IconButton, ProgressBar, SectionTitle, Skeleton, Spinner, Toggle } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { chapterDownloadable, rematchOutcomeKey, toQueueChapters } from '../lib/chapters.js';

type ViewMode = 'grid' | 'grid-compact' | 'list';
type SortKey = 'recent' | 'title' | 'progress' | 'new' | 'gap';
type FilterId = 'new' | 'missing' | 'gap' | 'failing' | 'stale' | 'migration' | 'paused';

interface DisplayPrefs {
    progress: boolean;
    date: boolean;
    source: boolean;
    missing: boolean;
    actions: boolean;
}

const GAP_THRESHOLD = 10;
const STALE_DAYS = 7;
const VIEW_KEY = 'tanko.library.view';
const PREFS_KEY = 'tanko.library.prefs';
const DEFAULT_PREFS: DisplayPrefs = { progress: true, date: true, source: true, missing: true, actions: false };

function missingCount(entry: LibraryEntryDto): number {
    return Math.max(0, entry.chapterCount - entry.downloadedCount);
}

function progressOf(entry: LibraryEntryDto): number {
    return entry.chapterCount > 0 ? (entry.downloadedCount / entry.chapterCount) * 100 : 0;
}

function checkedAt(entry: LibraryEntryDto): number {
    return entry.lastCheckedAt ? Date.parse(entry.lastCheckedAt) : 0;
}

function isStale(entry: LibraryEntryDto): boolean {
    return Date.now() - checkedAt(entry) > STALE_DAYS * 86_400_000;
}

function progressTone(entry: LibraryEntryDto): 'orange' | 'green' {
    return entry.newCount > 0 ? 'orange' : 'green';
}
/** Column classes per grid view (kept literal for Tailwind's scanner). */
const GRID_CLASSES: Record<Exclude<ViewMode, 'list'>, string> = {
    grid: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
    'grid-compact': 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7'
};

function gridClassName(view: ViewMode): string {
    return `grid gap-4 ${GRID_CLASSES[view === 'grid-compact' ? 'grid-compact' : 'grid']}`;
}

const FILTER_IDS: FilterId[] = ['new', 'missing', 'gap', 'failing', 'stale', 'migration', 'paused'];
const FILTER_PREDS: Record<FilterId, (entry: LibraryEntryDto) => boolean> = {
    new: entry => entry.newCount > 0,
    missing: entry => missingCount(entry) > 0,
    gap: entry => missingCount(entry) >= GAP_THRESHOLD,
    failing: entry => (entry.checkFailures ?? 0) > 0,
    stale: isStale,
    migration: entry => !!entry.migrationSuggestion,
    paused: entry => entry.paused === true
};

const SORTERS: Record<SortKey, (a: LibraryEntryDto, b: LibraryEntryDto) => number> = {
    recent: (a, b) => checkedAt(b) - checkedAt(a),
    title: (a, b) => a.title.localeCompare(b.title),
    progress: (a, b) => progressOf(a) - progressOf(b),
    new: (a, b) => b.newCount - a.newCount,
    gap: (a, b) => missingCount(b) - missingCount(a)
};

function loadView(): ViewMode {
    const view = localStorage.getItem(VIEW_KEY);
    return view === 'list' || view === 'grid-compact' ? view : 'grid';
}

function loadPrefs(): DisplayPrefs {
    try {
        return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
    } catch {
        return DEFAULT_PREFS;
    }
}

export default function Library({
    library,
    loaded,
    refreshLibrary,
    focusFilter,
    onFocusFilterDone,
    onOpenSeries
}: {
    library: LibraryEntryDto[];
    loaded: boolean;
    refreshLibrary: () => Promise<void>;
    focusFilter?: string | null;
    onFocusFilterDone?: () => void;
    onOpenSeries?: (id: number) => void;
}) {
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [expanded, setExpanded] = useState<number | null>(null);
    const [chapters, setChapters] = useState<LibraryChapterDto[] | null>(null);
    const [filter, setFilter] = useState('');
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
    const { t, formatDate } = useI18n();

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
            await api.enqueue({
                sourceId: entry.sourceId,
                mangaId: entry.mangaId,
                mangaTitle: entry.title,
                chapters: toQueueChapters([chapter])
            });
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

    const statusBadges = (entry: LibraryEntryDto) => (
        <>
            {entry.newCount > 0 && <Badge tone="orange">+{entry.newCount}</Badge>}
            {(entry.checkFailures ?? 0) > 0 && (
                <Badge tone="red" solid>
                    {t('library.failuresShort', { n: entry.checkFailures ?? 0 })}
                </Badge>
            )}
        </>
    );

    const statLine = (entry: LibraryEntryDto) => (
        <>
            {entry.chapterCount > 0 ? (
                <span className="text-zinc-300">{t('library.chaptersRatio', { downloaded: entry.downloadedCount, total: entry.chapterCount })}</span>
            ) : (
                <span className="text-red-400">{t('library.noSourceBadge')}</span>
            )}
            {prefs.missing && missingCount(entry) > 0 && (
                <>
                    <span className="text-zinc-700">·</span>
                    <span className="text-accent-soft">{t('library.missingCount', { n: missingCount(entry) })}</span>
                </>
            )}
            {prefs.date && entry.lastCheckedAt && (
                <>
                    <span className="text-zinc-700">·</span>
                    <span className="text-faint">{t('library.seen', { date: formatDate(entry.lastCheckedAt) })}</span>
                </>
            )}
        </>
    );

    /** Primary actions stay inline on the card; rare ones move to the overflow menu. */
    const primaryActions = (entry: LibraryEntryDto, withChapters = true) => (
        <>
            <IconButton title={t('library.check')} onClick={() => checkEntry(entry)} loading={busy[`check-${entry.id}`]}>
                <IconRefresh size={14} />
            </IconButton>
            <IconButton
                title={t('library.downloadNew')}
                onClick={() => downloadNew(entry)}
                disabled={entry.newCount === 0 && (entry.failedCount ?? 0) === 0}
                loading={busy[`dl-${entry.id}`]}
            >
                <IconDownload size={14} />
            </IconButton>
            {withChapters && (
                <IconButton title={expanded === entry.id ? t('library.hide') : t('discover.chapters')} onClick={() => openChapters(entry)}>
                    <IconList size={14} />
                </IconButton>
            )}
        </>
    );

    /** Labeled dropdown for secondary actions (rematch, undo migration, remove/restore). */
    const actionMenu = (entry: LibraryEntryDto, withChapters = false) => {
        const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false, loading = false) => (
            <button
                type="button"
                disabled={loading}
                onClick={() => {
                    setMenuFor(null);
                    onClick();
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors disabled:opacity-50 ${
                    danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
            >
                <span className="flex-none">{loading ? <Spinner size={13} /> : icon}</span>
                {label}
            </button>
        );
        return (
            <div className="relative" ref={menuFor === entry.id ? menuRef : undefined}>
                <IconButton title={t('library.moreActions')} onClick={() => setMenuFor(current => (current === entry.id ? null : entry.id))}>
                    <IconDots size={14} />
                </IconButton>
                {menuFor === entry.id && (
                    <div className="absolute bottom-8 right-0 z-30 w-48 rounded-xl border border-line bg-surface p-1.5 shadow-xl shadow-black/60">
                        {withChapters &&
                            item(<IconList size={14} />, expanded === entry.id ? t('library.hide') : t('discover.chapters'), () => openChapters(entry))}
                        {item(<IconSearch size={14} />, t('library.rematch'), () => rematch(entry), false, busy[`rematch-${entry.id}`])}
                        {item(
                            entry.paused ? <IconPlay size={14} /> : <IconPause size={14} />,
                            entry.paused ? t('library.resumeFollow') : t('library.pauseFollow'),
                            () => togglePaused(entry)
                        )}
                        {entry.canRollbackMigration && item(<IconUndo size={14} />, t('library.rollbackMigrationHint'), () => undoMigration(entry))}
                        <div className="my-1 border-t border-line" />
                        {showHidden
                            ? item(<IconRefresh size={14} />, t('library.reestablish'), () => restoreEntry(entry))
                            : item(<IconTrash size={14} />, t('library.remove'), () => setPendingRemove(entry), true)}
                    </div>
                )}
            </div>
        );
    };

    /** List rows have room: everything stays inline. */
    const secondaryActions = (entry: LibraryEntryDto) => (
        <>
            <IconButton title={t('library.rematchHint')} onClick={() => rematch(entry)} loading={busy[`rematch-${entry.id}`]}>
                <IconSearch size={14} />
            </IconButton>
            <IconButton title={entry.paused ? t('library.resumeFollow') : t('library.pauseFollow')} onClick={() => togglePaused(entry)}>
                {entry.paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            </IconButton>
            {entry.canRollbackMigration && (
                <IconButton title={t('library.rollbackMigrationHint')} onClick={() => undoMigration(entry)}>
                    <IconUndo size={14} />
                </IconButton>
            )}
            {showHidden ? (
                <IconButton title={t('library.reestablish')} onClick={() => restoreEntry(entry)}>
                    <IconRefresh size={14} />
                </IconButton>
            ) : (
                <IconButton title={t('library.remove')} variant="danger" onClick={() => setPendingRemove(entry)}>
                    <IconTrash size={14} />
                </IconButton>
            )}
        </>
    );

    const migrationBanner = (entry: LibraryEntryDto, className = '') =>
        entry.migrationSuggestion && (
            <div className={`flex flex-wrap items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs ${className}`}>
                <span className="text-zinc-300">
                    {t('library.migrationSuggested')} <b>{entry.migrationSuggestion.mangaTitle}</b> ({entry.migrationSuggestion.sourceLabel},{' '}
                    {Math.round((entry.migrationSuggestion.score ?? 0) * 100)}%)
                </span>
                <Button small onClick={() => confirmMigration(entry, true)}>
                    {t('library.migrate')}
                </Button>
                <Button small variant="ghost" onClick={() => confirmMigration(entry, false)}>
                    <IconX size={12} />
                </Button>
            </div>
        );

    const chaptersPanel = (entry: LibraryEntryDto, className = '') =>
        expanded === entry.id && (
            <div className={`max-h-56 space-y-1 overflow-y-auto rounded-lg bg-zinc-950/60 p-2 ${className}`}>
                {chapters === null && (
                    <div className="p-2 text-sm text-zinc-500">
                        <Spinner />
                    </div>
                )}
                {chapters?.map(chapter => (
                    <div key={chapter.id} className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                        <span className="truncate text-zinc-300" title={chapter.path || ''}>
                            {chapter.title}
                        </span>
                        <span className="flex items-center gap-1.5">
                            {chapterDownloadable(chapter.status) && (
                                <button
                                    type="button"
                                    title={chapter.status === 'failed' ? t('library.retryChapterHint') : t('library.downloadChapterHint')}
                                    onClick={() => downloadChapter(entry, chapter)}
                                    className="text-zinc-500 transition-colors hover:text-accent-soft"
                                >
                                    <IconDownload size={13} />
                                </button>
                            )}
                            {(chapter.historyCount ?? 0) > 0 && (
                                <button
                                    type="button"
                                    title={t('library.restoreFileHint')}
                                    onClick={() => rollbackChapter(entry, chapter)}
                                    className="text-zinc-500 transition-colors hover:text-orange-400"
                                >
                                    ⟲
                                </button>
                            )}
                            <ChapterStatusBadge chapter={chapter} />
                        </span>
                    </div>
                ))}
            </div>
        );

    const renderGridCard = (entry: LibraryEntryDto) => (
        <article
            key={entry.id}
            {...longPress(entry.id)}
            className={`relative rounded-xl border bg-surface/60 transition-colors hover:border-zinc-600 ${selecting && selectedIds.has(entry.id) ? 'border-accent/60' : 'border-line'}`}
        >
            <div className="relative aspect-[2/3] overflow-hidden rounded-t-xl">
                <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="absolute inset-0 h-full w-full" />
                <div className="absolute left-2 top-2 flex flex-col items-start gap-1">{statusBadges(entry)}</div>
                {selecting ? (
                    <button
                        type="button"
                        title={entry.title}
                        aria-label={entry.title}
                        onClick={() => toggleSelect(entry.id)}
                        className={`absolute right-2 top-2 rounded-md border border-line bg-zinc-900/80 p-1.5 transition-colors ${selectedIds.has(entry.id) ? 'text-accent-soft' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        {selectedIds.has(entry.id) ? <IconCheck size={13} /> : <IconBookmark size={13} />}
                    </button>
                ) : (
                    <button
                        type="button"
                        title={entry.autoDownload ? t('library.following') : t('library.manualDl')}
                        onClick={() => toggleFollow(entry, !entry.autoDownload)}
                        className={`absolute right-2 top-2 rounded-md border border-line bg-zinc-900/80 p-1.5 transition-colors ${entry.autoDownload ? 'text-accent-soft' : 'text-zinc-500 hover:text-zinc-300'}`}
                    >
                        {entry.autoDownload ? <IconBookmarkFilled size={13} /> : <IconBookmark size={13} />}
                    </button>
                )}
            </div>
            <div className="space-y-1.5 p-3">
                <button
                    type="button"
                    className="line-clamp-2 min-h-[2.5em] w-full text-left text-sm font-semibold leading-tight transition-colors hover:text-accent-soft"
                    title={entry.title}
                    onClick={() => (selecting ? toggleSelect(entry.id) : onOpenSeries?.(entry.id))}
                >
                    {entry.title}
                </button>
                <div className="flex flex-wrap items-center gap-1">
                    {prefs.source && (entry.sourceLabel ? <Badge>{entry.sourceLabel}</Badge> : <Badge tone="red">{t('library.noSourceBadge')}</Badge>)}
                    {entry.paused && <Badge>{t('library.paused')}</Badge>}
                </div>
                <div className="flex min-h-[2.125rem] flex-wrap content-start items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4">{statLine(entry)}</div>
                {prefs.progress && <ProgressBar value={progressOf(entry)} tone={progressTone(entry)} />}
                {migrationBanner(entry)}
                <div className="card-actions flex items-center justify-between pt-0.5">
                    <div className="flex items-center gap-1">{primaryActions(entry, view !== 'grid-compact')}</div>
                    {actionMenu(entry, view === 'grid-compact')}
                </div>
                {chaptersPanel(entry)}
            </div>
        </article>
    );

    const renderListRow = (entry: LibraryEntryDto) => (
        <article
            key={entry.id}
            {...longPress(entry.id)}
            className={`rounded-xl border bg-surface/60 p-2.5 transition-colors hover:border-zinc-600 ${selecting && selectedIds.has(entry.id) ? 'border-accent/60' : 'border-line'}`}
        >
            <div className="flex items-center gap-3">
                {selecting && (
                    <input
                        type="checkbox"
                        checked={selectedIds.has(entry.id)}
                        onChange={() => toggleSelect(entry.id)}
                        aria-label={entry.title}
                        className="flex-none accent-orange-500"
                    />
                )}
                <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="h-16 w-11 flex-none rounded-md" />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            className="truncate text-sm font-semibold transition-colors hover:text-accent-soft"
                            title={entry.title}
                            onClick={() => (selecting ? toggleSelect(entry.id) : onOpenSeries?.(entry.id))}
                        >
                            {entry.title}
                        </button>
                        {statusBadges(entry)}
                        {entry.paused && <Badge>{t('library.paused')}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                        {prefs.source && (
                            <>
                                {entry.sourceLabel ? (
                                    <span className="text-muted">{entry.sourceLabel}</span>
                                ) : (
                                    <span className="text-red-400">{t('library.noSourceBadge')}</span>
                                )}
                                <span className="text-zinc-700">·</span>
                            </>
                        )}
                        {statLine(entry)}
                    </div>
                </div>
                {prefs.progress && (
                    <div className="hidden w-32 flex-none sm:block">
                        <div className="mb-1 text-right text-[11px] text-muted">{Math.round(progressOf(entry))}%</div>
                        <ProgressBar value={progressOf(entry)} tone={progressTone(entry)} />
                    </div>
                )}
                <Toggle
                    checked={entry.autoDownload}
                    onChange={value => toggleFollow(entry, value)}
                    label={entry.autoDownload ? t('library.following') : t('library.manualDl')}
                />
                <div className="card-actions flex flex-none items-center gap-1">
                    {primaryActions(entry)}
                    {secondaryActions(entry)}
                </div>
            </div>
            {migrationBanner(entry, 'mt-2')}
            {chaptersPanel(entry, 'mt-2')}
        </article>
    );

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
                    {FILTER_IDS.map(id => {
                        const on = activeFilters.has(id);
                        const count = source.filter(FILTER_PREDS[id]).length;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => toggleFilter(id)}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? 'border-accent/50 bg-accent/10 text-accent-soft' : 'border-line bg-canvas text-muted hover:border-zinc-600'}`}
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
                <Card className="flex flex-wrap items-center gap-2 p-3">
                    <span className="text-sm text-muted">{t('library.selectionCount', { n: selectedInView })}</span>
                    <Button small variant="ghost" onClick={toggleSelectAll} disabled={filtered.length === 0}>
                        {allInViewSelected ? t('library.deselectAll') : t('library.selectAll')}
                    </Button>
                    <Button small onClick={() => runBulk('check')} disabled={selectedInView === 0} loading={bulkBusy === 'check'}>
                        <IconRefresh size={13} /> {t('library.checkSelected', { n: selectedInView })}
                    </Button>
                    <Button small onClick={() => runBulk('downloadNew')} disabled={selectedInView === 0} loading={bulkBusy === 'downloadNew'}>
                        <IconDownload size={13} /> {t('library.downloadSelected', { n: selectedInView })}
                    </Button>
                    <Button small onClick={() => runBulk('pause')} disabled={selectedInView === 0} loading={bulkBusy === 'pause'}>
                        <IconPause size={13} /> {t('library.pauseSelected')}
                    </Button>
                    <Button small onClick={() => runBulk('resume')} disabled={selectedInView === 0} loading={bulkBusy === 'resume'}>
                        <IconPlay size={13} /> {t('library.resumeSelected')}
                    </Button>
                    <Button small onClick={() => runBulk('hide')} disabled={selectedInView === 0} loading={bulkBusy === 'hide'}>
                        <IconEyeOff size={13} /> {t('library.hideSelected')}
                    </Button>
                    {showHidden && (
                        <Button small onClick={() => runBulk('unhide')} disabled={selectedInView === 0} loading={bulkBusy === 'unhide'}>
                            <IconRefresh size={13} /> {t('library.unhideSelected')}
                        </Button>
                    )}
                    <Button small onClick={() => runBulk('rematch')} disabled={selectedInView === 0} loading={bulkBusy === 'rematch'}>
                        <IconSearch size={13} /> {t('library.rematch')}
                    </Button>
                    <Button small variant="danger" onClick={() => setPendingBulkRemove(true)} disabled={selectedInView === 0}>
                        <IconTrash size={13} /> {t('library.removeSelected', { n: selectedInView })}
                    </Button>
                    <Button small variant="ghost" onClick={exitSelection}>
                        {t('common.cancel')}
                    </Button>
                </Card>
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
                <EmptyState title={t('library.noSeries')} hint={t('library.noSeriesHint')} icon={<IconLibrary size={28} />} />
            )}
            {loaded && filtered.length === 0 && source.length === 0 && showHidden && (
                <EmptyState title={t('library.noHidden')} hint={t('library.noHiddenHint')} icon={<IconEyeOff size={28} />} />
            )}
            {loaded && filtered.length === 0 && source.length > 0 && <EmptyState title={t('library.noMatch')} icon={<IconSearch size={28} />} />}

            {loaded && filtered.length > 0 && view === 'list' && <div className="space-y-2">{filtered.map(renderListRow)}</div>}
            {loaded && filtered.length > 0 && view !== 'list' && <div className={gridClassName(view)}>{filtered.map(renderGridCard)}</div>}

            {pendingRemove !== null && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener above)
                <div
                    className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={event => {
                        if (event.target === event.currentTarget) setPendingRemove(null);
                    }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('library.removeTitle', { title: pendingRemove.title })}
                        className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
                    >
                        <div className="text-sm font-semibold text-fg">{t('library.removeTitle', { title: pendingRemove.title })}</div>
                        <div className="mt-1 text-xs text-muted">{t('library.removeChoice')}</div>
                        <div className="mt-4 space-y-2">
                            <button
                                type="button"
                                onClick={hideEntry}
                                className="flex w-full items-start gap-3 rounded-lg border border-line bg-zinc-950/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-zinc-900"
                            >
                                <span className="mt-0.5 text-zinc-400">
                                    <IconEyeOff size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-fg">{t('library.hideFromTanko')}</span>
                                    <span className="mt-0.5 block text-xs text-muted">{t('library.hideFromTankoHint')}</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={askRemoveFromDisk}
                                className="flex w-full items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-left transition-colors hover:border-red-500/60 hover:bg-red-500/10"
                            >
                                <span className="mt-0.5 text-red-400">
                                    <IconFolder size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-red-300">{t('library.deleteFromDisk')}</span>
                                    <span className="mt-0.5 block text-xs text-red-300/70">{t('library.deleteFromDiskHint')}</span>
                                </span>
                            </button>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <Button small variant="ghost" onClick={() => setPendingRemove(null)}>
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {pendingBulkRemove && selecting && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; same pattern as the single-remove dialog above
                <div
                    className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={event => {
                        if (event.target === event.currentTarget) {
                            setPendingBulkRemove(false);
                        }
                    }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('library.bulkRemoveTitle', { n: selectedInView })}
                        className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
                    >
                        <div className="text-sm font-semibold text-fg">{t('library.bulkRemoveTitle', { n: selectedInView })}</div>
                        <div className="mt-4 space-y-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setPendingBulkRemove(false);
                                    void runBulk('delete');
                                }}
                                className="flex w-full items-start gap-3 rounded-lg border border-line bg-zinc-950/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-zinc-900"
                            >
                                <span className="mt-0.5 text-zinc-400">
                                    <IconLibrary size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-fg">{t('library.bulkRemoveOnly')}</span>
                                    <span className="mt-0.5 block text-xs text-muted">{t('library.bulkRemoveOnlyHint')}</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setPendingBulkRemove(false);
                                    void runBulk('delete', true);
                                }}
                                className="flex w-full items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-left transition-colors hover:border-red-500/60 hover:bg-red-500/10"
                            >
                                <span className="mt-0.5 text-red-400">
                                    <IconFolder size={16} />
                                </span>
                                <span>
                                    <span className="block text-sm font-medium text-red-300">{t('library.bulkRemoveDisk')}</span>
                                    <span className="mt-0.5 block text-xs text-red-300/70">{t('library.bulkRemoveDiskHint')}</span>
                                </span>
                            </button>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <Button small variant="ghost" onClick={() => setPendingBulkRemove(false)}>
                                {t('common.cancel')}
                            </Button>
                        </div>
                    </div>
                </div>
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
