/**
 * Library view (Sonarr-like): tracked series with follow toggle, new-chapter
 * badges, on-demand check / download-new / remove, bulk selection, migration
 * review and hidden-series management.
 * Async actions live in `useLibraryActions`, the toolbar in `LibraryToolbar`
 * and the loading placeholders in `LibrarySkeleton`; this view owns the
 * selection / filter / display state and composes everything.
 */
import type { LibraryEntryDto } from '@tanko/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/confirm.js';
import { IconArrowLeftRight, IconCheck, IconDownload, IconEyeOff, IconImport, IconLibrary, IconRefresh, IconSearch } from '../components/icons.js';
import { BulkActionBar } from '../components/library/BulkActionBar.js';
import type { EntryCardHandlers, EntryCardState } from '../components/library/EntryCard.js';
import { EntryGridCard, EntryListRow } from '../components/library/EntryCard.js';
import { BulkRemoveDialog, RemoveEntryDialog } from '../components/library/EntryDialogs.js';
import { LibrarySkeleton } from '../components/library/LibrarySkeleton.js';
import { LibraryToolbar } from '../components/library/LibraryToolbar.js';
import { useLibraryActions } from '../components/library/useLibraryActions.js';
import { MigrationBanner } from '../components/MigrationBanner.js';
import { MigrationModal } from '../components/MigrationModal.js';
import { Badge, Button, EmptyState } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { useLongPress } from '../lib/hooks.js';
import {
    type DisplayPrefs,
    FILTER_IDS,
    FILTER_PREDS,
    type FilterId,
    gridClassName,
    loadPrefs,
    loadView,
    PREFS_KEY,
    SORTERS,
    type SortKey,
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
    const [filter, setFilter] = useState('');
    const [showHidden, setShowHidden] = useState(false);
    const [migrationOpen, setMigrationOpen] = useState(false);
    const [migrationBannerHidden, setMigrationBannerHidden] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [sort, setSort] = useState<SortKey>('recent');
    const [view, setView] = useState<ViewMode>(loadView);
    const [activeFilters, setActiveFilters] = useState<Set<FilterId>>(new Set());
    const [prefs, setPrefs] = useState<DisplayPrefs>(loadPrefs);
    const [menuFor, setMenuFor] = useState<number | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const { t } = useI18n();

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

    const {
        busy,
        expanded,
        chapters,
        source,
        hiddenList,
        pendingRemove,
        setPendingRemove,
        pendingDisk,
        setPendingDisk,
        diskPath,
        pendingBulkRemove,
        setPendingBulkRemove,
        pendingRescan,
        setPendingRescan,
        bulkBusy,
        rematchAllBusy,
        rescanBusy,
        dlAllBusy,
        checkEntry,
        downloadNew,
        downloadAllNew,
        runBulk,
        hideEntry,
        askRemoveFromDisk,
        confirmRemoveFromDisk,
        rematchAllFailed,
        rescan,
        confirmRescan,
        restoreEntry,
        toggleFollow,
        togglePaused,
        rematch,
        confirmMigration,
        undoMigration,
        rollbackChapter,
        downloadChapter,
        openChapters
    } = useLibraryActions({ library, refreshLibrary, showHidden, selectedIds, exitSelection });

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

    // long-press on a card or row enters selection mode and toggles that entry
    const longPress = useLongPress(!selecting, id => {
        setSelecting(true);
        toggleSelect(id);
    });

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

    const updatePref = (key: keyof DisplayPrefs, value: boolean) => setPrefs(current => ({ ...current, [key]: value }));

    // clicking the sidebar "new" badge focuses the library on new chapters (consumed once)
    useEffect(() => {
        if (focusFilter !== 'new') return;
        setActiveFilters(new Set<FilterId>(['new']));
        onFocusFilterDone?.();
    }, [focusFilter, onFocusFilterDone]);

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
            <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h2 className="flex flex-wrap items-center gap-2 font-display text-2xl font-bold tracking-tight">
                        {t('library.title')}
                        {showHidden && <Badge tone="purple">{t('library.hiddenSeries')}</Badge>}
                    </h2>
                    <p className="mt-1 text-sm text-muted">
                        {t('library.seriesCount', { n: library.length })}
                        {totalNew > 0 && (
                            <>
                                {' · '}
                                <span className="font-semibold text-accent-soft">{t('library.newChaptersCount', { n: totalNew })}</span>
                            </>
                        )}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {failingCount > 0 && (
                        <Button small variant="ghost" onClick={rematchAllFailed} loading={rematchAllBusy} title={t('library.rematchFailedHint')}>
                            <IconSearch size={13} /> {t('library.rematchFailed', { n: failingCount })}
                        </Button>
                    )}
                    {pendingMigrations.length > 0 && migrationBannerHidden && (
                        <Button small variant="ghost" onClick={() => setMigrationOpen(true)} title={t('library.migrationProcessHint')}>
                            <IconArrowLeftRight size={13} /> {t('library.migrationProcess', { n: pendingMigrations.length })}
                        </Button>
                    )}
                    <Button small variant={showHidden ? 'primary' : 'ghost'} onClick={() => setShowHidden(current => !current)}>
                        <IconEyeOff size={13} /> {t('library.hidden')}
                        {hiddenList.length > 0 ? ` (${hiddenList.length})` : ''}
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
                    <Button small variant="ghost" onClick={rescan} loading={rescanBusy} title={t('library.rescanHint')}>
                        <IconRefresh size={13} /> {t('library.rescan')}
                    </Button>
                    <Button small onClick={downloadAllNew} loading={dlAllBusy} disabled={totalNew === 0} title={t('library.downloadAllNewHint')}>
                        <IconDownload size={13} /> {t('library.downloadAllNew')}
                        {totalNew > 0 && <span className="rounded-md bg-canvas/20 px-1.5 text-xs font-bold text-canvas">{totalNew}</span>}
                    </Button>
                </div>
            </div>

            {pendingMigrations.length > 0 && !migrationBannerHidden && (
                <MigrationBanner count={pendingMigrations.length} onReview={() => setMigrationOpen(true)} onLater={() => setMigrationBannerHidden(true)} />
            )}

            <LibraryToolbar
                filter={filter}
                onFilterChange={setFilter}
                sort={sort}
                onSortChange={setSort}
                view={view}
                onViewChange={setView}
                prefs={prefs}
                onPrefChange={updatePref}
                activeFilters={activeFilters}
                onToggleFilter={toggleFilter}
                onClearFilters={() => setActiveFilters(new Set())}
                countsSource={source}
            />

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

            {!loaded && <LibrarySkeleton view={view} />}

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
                            <code className="mt-1 block break-all rounded bg-canvas px-2 py-1 text-xs text-fg">{diskPath}</code>
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
                                <code className="truncate text-xs text-faint" title={entry.directory ?? undefined}>
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
