/**
 * Async actions backing the Library view: per-entry and bulk operations
 * (check, download, rematch, hide, remove, rescan) with their busy flags,
 * pending-dialog state and toasts. All of it lives here — the view renders.
 */
import type { DeadSeriesDto, LibraryBulkAction, LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { enqueueEntryChapters, rematchOutcomeKey } from '../../lib/chapters.js';
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

    const setBusyFlag = (key: string, value: boolean) => setBusy(current => ({ ...current, [key]: value }));

    const checkEntry = async (entry: LibraryEntryDto) => {
        setBusyFlag(`check-${entry.id}`, true);
        try {
            const result = await api.checkEntry(entry.id);
            toast.info(
                result.newChapters > 0 ? t('library.newChapters', { n: result.newChapters, title: entry.title }) : t('library.upToDate', { title: entry.title })
            );
            await refreshLibrary();
            // keep an open chapters panel in step with the new statuses
            if (expanded === entry.id) {
                setChapters(await api.entryChapters(entry.id));
            }
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
            // keep an open chapters panel in step with the new statuses
            if (expanded === entry.id) {
                setChapters(await api.entryChapters(entry.id));
            }
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
