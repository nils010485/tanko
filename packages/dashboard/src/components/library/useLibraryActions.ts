/**
 * Async actions backing the Library view: per-entry and bulk operations
 * (check, download, rematch, hide, remove, rescan) with their busy flags,
 * pending-dialog state and toasts. All of it lives here — the view renders.
 */
import type { DeadSeriesDto, LibraryBulkAction, LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { createEntryActions } from '../../lib/entry-actions.js';
import { useToast } from '../toast.js';

export function useLibraryActions({
    library,
    refreshLibrary,
    showHidden,
    selectedIds,
    exitSelection
}: {
    library: LibraryEntryDto[];
    refreshLibrary: () => Promise<void>;
    showHidden: boolean;
    selectedIds: Set<number>;
    exitSelection: () => void;
}) {
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [expanded, setExpanded] = useState<number | null>(null);
    const [chapters, setChapters] = useState<LibraryChapterDto[] | null>(null);
    const [pendingRemove, setPendingRemove] = useState<LibraryEntryDto | null>(null);
    const [pendingDisk, setPendingDisk] = useState<LibraryEntryDto | null>(null);
    const [pendingBulkRemove, setPendingBulkRemove] = useState(false);
    const [diskPath, setDiskPath] = useState<string | null>(null);
    const [rematchAllBusy, setRematchAllBusy] = useState(false);
    const [rescanBusy, setRescanBusy] = useState(false);
    const [dlAllBusy, setDlAllBusy] = useState(false);
    const [bulkBusy, setBulkBusy] = useState<string | null>(null);
    const [pendingRescan, setPendingRescan] = useState<DeadSeriesDto[] | null>(null);
    const [hiddenList, setHiddenList] = useState<LibraryEntryDto[]>([]);
    const toast = useToast();
    const { t } = useI18n();

    const source = showHidden ? hiddenList : library;

    const refreshHidden = useCallback(async () => {
        try {
            setHiddenList(await api.library(true));
        } catch (error) {
            toast.error((error as Error).message);
        }
    }, [toast]);
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

    const setBusyFlag = (key: string, value: boolean) => setBusy(current => ({ ...current, [key]: value }));

    const actions = createEntryActions({
        t,
        toast,
        refreshLibrary,
        setBusy: setBusyFlag,
        // keep an open chapters panel in step with the new statuses
        reloadChapters: async entryId => {
            if (expanded === entryId) {
                setChapters(await api.entryChapters(entryId));
            }
        }
    });

    const checkEntry = (entry: LibraryEntryDto) => actions.checkEntry(entry, `check-${entry.id}`);

    const downloadNew = (entry: LibraryEntryDto) => actions.downloadNew(entry, `dl-${entry.id}`);

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

    const togglePaused = (entry: LibraryEntryDto) => actions.togglePaused(entry);

    const rematch = (entry: LibraryEntryDto) => actions.rematch(entry, `rematch-${entry.id}`);

    const confirmMigration = (entry: LibraryEntryDto, apply: boolean) => actions.confirmMigration(entry, apply);

    const undoMigration = (entry: LibraryEntryDto) => actions.undoMigration(entry);

    const rollbackChapter = (entry: LibraryEntryDto, chapter: LibraryChapterDto) => actions.rollbackChapter(entry, chapter);

    /** Queue one chapter (download or retry) via the ad-hoc endpoint; the route
     *  resolves the entry so the chapter status follows the job. */
    const downloadChapter = (entry: LibraryEntryDto, chapter: LibraryChapterDto) => actions.downloadChapter(entry, chapter);

    /** Ignore responses that resolve after the user switched entries. */
    const chaptersSeq = useRef(0);
    const openChapters = async (entry: LibraryEntryDto) => {
        if (expanded === entry.id) {
            setExpanded(null);
            setChapters(null);
            return;
        }
        const seq = ++chaptersSeq.current;
        setExpanded(entry.id);
        setChapters(null);
        try {
            const list = await api.entryChapters(entry.id);
            if (chaptersSeq.current === seq) {
                setChapters(list);
            }
        } catch (error) {
            if (chaptersSeq.current === seq) {
                setChapters([]);
                toast.error((error as Error).message);
            }
        }
    };

    return {
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
    };
}
