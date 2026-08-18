/**
 * Library view (Sonarr-like): tracked series with follow toggle, new-chapter
 * badges, on-demand check / download-new / remove.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useI18n } from '../i18n/index.js';
import { Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, Skeleton, Spinner, Toggle } from '../components/ui.js';
import { Cover } from '../components/Cover.js';
import { ConfirmDialog } from '../components/confirm.js';
import { useToast } from '../components/toast.js';
import { IconDownload, IconEyeOff, IconFolder, IconLibrary, IconRefresh, IconSearch, IconTrash, IconX } from '../components/icons.js';
import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';

export default function Library({ library, loaded, refreshLibrary }: { library: LibraryEntryDto[]; loaded: boolean; refreshLibrary: () => Promise<void> }) {
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [expanded, setExpanded] = useState<number | null>(null);
    const [chapters, setChapters] = useState<LibraryChapterDto[] | null>(null);
    const [filter, setFilter] = useState('');
    const [pendingRemove, setPendingRemove] = useState<LibraryEntryDto | null>(null);
    const [pendingDisk, setPendingDisk] = useState<LibraryEntryDto | null>(null);
    const [diskPath, setDiskPath] = useState<string | null>(null);
    const [showHidden, setShowHidden] = useState(false);
    const [rematchAllBusy, setRematchAllBusy] = useState(false);
    const [hiddenList, setHiddenList] = useState<LibraryEntryDto[]>([]);
    const toast = useToast();
    const { t, formatDate } = useI18n();

    const refreshHidden = async () => {
        try {
            setHiddenList(await api.library(true));
        } catch { /* keep the last known list */ }
    };
    useEffect(() => { void refreshHidden(); }, [library]);

    const setBusyFlag = (key: string, value: boolean) => setBusy(current => ({ ...current, [key]: value }));

    const checkEntry = async (entry: LibraryEntryDto) => {
        setBusyFlag(`check-${entry.id}`, true);
        try {
            const result = await api.checkEntry(entry.id);
            if (result.newChapters > 0 && entry.autoDownload) {
                await api.downloadNew(entry.id);
            }
            toast.info(result.newChapters > 0
                ? t('library.newChapters', { n: result.newChapters, title: entry.title })
                : t('library.upToDate', { title: entry.title }));
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
        } catch { /* the confirm dialog falls back to a generic message */ }
    };

    const confirmRemoveFromDisk = async () => {
        const entry = pendingDisk;
        if (!entry) return;
        setPendingDisk(null);
        try {
            const result = await api.removeFromLibrary(entry.id, true);
            toast.success(result.deletedPath
                ? t('library.removedWithDisk', { title: entry.title, path: result.deletedPath })
                : t('library.removedNoDisk', { title: entry.title }));
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
            toast.info(result.started
                ? t('library.rematchStarted', { n: result.count })
                : t('library.noFailedToRematch'));
            if (result.started) {
                setTimeout(() => { void refreshLibrary(); }, 5000);
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRematchAllBusy(false);
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

    const rematch = async (entry: LibraryEntryDto) => {
        setBusyFlag(`rematch-${entry.id}`, true);
        try {
            const result = await api.rematchEntry(entry.id);
            toast.info(result.outcome === 'migrated'
                ? t('library.migratedTo', { title: entry.title, source: result.entry?.sourceLabel ?? '' })
                : result.outcome === 'suggested'
                    ? t('library.migrationSuggestedToast', { title: entry.title })
                    : t('library.noAlternateSource', { title: entry.title }));
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

    const source = showHidden ? hiddenList : library;
    const filtered = source.filter(entry => entry.title.toLowerCase().includes(filter.toLowerCase()));
    const totalNew = library.reduce((sum, entry) => sum + entry.newCount, 0);

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                        <input
                            value={filter}
                            onChange={event => setFilter(event.target.value)}
                            placeholder={t('library.filter')}
                            className="w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent sm:w-44"
                        />
                        {(showHidden ? hiddenList : library).filter(entry => (entry.checkFailures ?? 0) > 0).length > 0 && (
                            <Button small variant="ghost" onClick={rematchAllFailed} loading={rematchAllBusy} title={t('library.rematchFailedHint')}>
                                <IconSearch size={13} /> {t('library.rematchFailed', { n: (showHidden ? hiddenList : library).filter(entry => (entry.checkFailures ?? 0) > 0).length })}
                            </Button>
                        )}
                        <Button small variant={showHidden ? 'primary' : 'ghost'} onClick={() => setShowHidden(current => !current)}>
                            <IconEyeOff size={13} /> {t('library.hidden')}{hiddenList.length > 0 ? ` (${hiddenList.length})` : ''}
                        </Button>
                    </div>
                }
            >
                {t('library.title')} {totalNew > 0 && <Badge tone="orange">{t('library.newBadge', { n: totalNew })}</Badge>}
                {showHidden && <Badge tone="purple">{t('library.hiddenSeries')}</Badge>}
            </SectionTitle>

            {!loaded && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <Card key={index} className="flex gap-4 p-4">
                            <Skeleton className="h-24 w-16 rounded-md" />
                            <div className="flex-1 space-y-2.5 py-1">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-3 w-1/2" />
                                <Skeleton className="h-1.5 w-full" />
                                <Skeleton className="h-6 w-3/4" />
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            {loaded && filtered.length === 0 && !showHidden && (
                <EmptyState title={t('library.noSeries')} hint={t('library.noSeriesHint')} icon={<IconLibrary size={28} />} />
            )}
            {loaded && filtered.length === 0 && showHidden && (
                <EmptyState title={t('library.noHidden')} hint={t('library.noHiddenHint')} icon={<IconEyeOff size={28} />} />
            )}

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {filtered.map(entry => {
                    const progress = entry.chapterCount > 0 ? (entry.downloadedCount / entry.chapterCount) * 100 : 0;
                    return (
                        <Card key={entry.id} className="flex gap-4 p-4">
                            <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="h-24 w-16 flex-none rounded-md" />
                            <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="truncate font-semibold" title={entry.title}>{entry.title}</div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                                        <Badge>{entry.sourceLabel}</Badge>
                                        {(entry.checkFailures ?? 0) > 0 && (
                                            <Badge tone="red">{t('library.failingSource', { n: entry.checkFailures ?? 0 })}</Badge>
                                        )}
                                        <span>{t('library.chaptersCount', { n: entry.chapterCount })}</span>
                                        <span>·</span>
                                        <span>{t('library.downloadedCount', { n: entry.downloadedCount })}</span>
                                        {entry.lastCheckedAt && (<><span>·</span><span>{t('library.seen', { date: formatDate(entry.lastCheckedAt) })}</span></>)}
                                    </div>
                                </div>
                                <Toggle checked={entry.autoDownload} onChange={value => toggleFollow(entry, value)} label={entry.autoDownload ? t('library.following') : t('library.paused')} />
                            </div>

                            <div className="mt-3">
                                <ProgressBar value={progress} tone={entry.newCount > 0 ? 'orange' : 'green'} />
                            </div>

                            {entry.migrationSuggestion && (
                                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs">
                                    <span className="text-zinc-300">
                                        {t('library.migrationSuggested')} <b>{entry.migrationSuggestion.mangaTitle}</b> ({entry.migrationSuggestion.sourceLabel}, {Math.round((entry.migrationSuggestion.score ?? 0) * 100)}%)
                                    </span>
                                    <Button small onClick={() => confirmMigration(entry, true)}>{t('library.migrate')}</Button>
                                    <Button small variant="ghost" onClick={() => confirmMigration(entry, false)}><IconX size={12} /></Button>
                                </div>
                            )}

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                {entry.newCount > 0 && <Badge tone="orange">+{t('library.newBadge', { n: entry.newCount })}</Badge>}
                                <Button small variant="ghost" onClick={() => checkEntry(entry)} loading={busy[`check-${entry.id}`]}>
                                    <IconRefresh size={13} /> {t('library.check')}
                                </Button>
                                <Button small variant="ghost" onClick={() => downloadNew(entry)} disabled={entry.newCount === 0} loading={busy[`dl-${entry.id}`]}>
                                    <IconDownload size={13} /> {t('library.downloadNew')}
                                </Button>
                                <Button small variant="ghost" onClick={() => openChapters(entry)}>
                                    {expanded === entry.id ? t('library.hide') : t('discover.chapters')}
                                </Button>
                                <Button small variant="ghost" title={t('library.rematchHint')} onClick={() => rematch(entry)} loading={busy[`rematch-${entry.id}`]}>
                                    <IconSearch size={13} /> {t('library.rematch')}
                                </Button>
                                {entry.canRollbackMigration && (
                                <Button small variant="ghost" title={t('library.rollbackMigrationHint')} onClick={() => undoMigration(entry)}>
                                    {t('library.rollbackMigration')}
                                </Button>
                                )}
                                <div className="flex-1" />
                                {showHidden
                                    ? <Button small variant="ghost" onClick={() => restoreEntry(entry)}><IconRefresh size={13} /> {t('library.reestablish')}</Button>
                                    : <Button small variant="danger" onClick={() => setPendingRemove(entry)}><IconTrash size={13} /> {t('library.remove')}</Button>}
                            </div>

                            {expanded === entry.id && (
                                <div className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg bg-zinc-950/60 p-2">
                                    {chapters === null && <div className="p-2 text-sm text-zinc-500"><Spinner /></div>}
                                    {chapters?.map(chapter => (
                                        <div key={chapter.id} className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                                            <span className="truncate text-zinc-300" title={chapter.path || ''}>{chapter.title}</span>
                                            <span className="flex items-center gap-1.5">
                                                {(chapter.historyCount ?? 0) > 0 && (
                                                    <button
                                                        type="button"
                                                        title={t('library.restoreFileHint')}
                                                        onClick={() => rollbackChapter(entry, chapter)}
                                                        className="text-zinc-500 transition-colors hover:text-orange-400"
                                                    >⟲</button>
                                                )}
                                                <Badge tone={chapter.status === 'downloaded' ? 'green' : chapter.status === 'failed' ? 'red' : chapter.status === 'new' ? 'orange' : 'blue'}>
                                                    {chapter.status}
                                                </Badge>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            </div>
                        </Card>
                    );
                })}
            </div>

            {pendingRemove !== null && (
                <div
                    className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={() => setPendingRemove(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('library.removeTitle', { title: pendingRemove.title })}
                        className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
                        onClick={event => event.stopPropagation()}
                    >
                        <div className="text-sm font-semibold text-fg">{t('library.removeTitle', { title: pendingRemove.title })}</div>
                        <div className="mt-1 text-xs text-muted">{t('library.removeChoice')}</div>
                        <div className="mt-4 space-y-2">
                            <button
                                type="button"
                                onClick={hideEntry}
                                className="flex w-full items-start gap-3 rounded-lg border border-line bg-zinc-950/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-zinc-900"
                            >
                                <span className="mt-0.5 text-zinc-400"><IconEyeOff size={16} /></span>
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
                                <span className="mt-0.5 text-red-400"><IconFolder size={16} /></span>
                                <span>
                                    <span className="block text-sm font-medium text-red-300">{t('library.deleteFromDisk')}</span>
                                    <span className="mt-0.5 block text-xs text-red-300/70">{t('library.deleteFromDiskHint')}</span>
                                </span>
                            </button>
                        </div>
                        <div className="mt-4 flex justify-end">
                            <Button small variant="ghost" onClick={() => setPendingRemove(null)}>{t('common.cancel')}</Button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={pendingDisk !== null}
                title={t('library.deleteTitle', { title: pendingDisk?.title ?? '' })}
                body={diskPath
                    ? <>{t('library.deleteBodyPath')}<code className="mt-1 block break-all rounded bg-zinc-950 px-2 py-1 text-xs text-zinc-300">{diskPath}</code></>
                    : t('library.deleteBodyGeneric')}
                confirmLabel={t('library.deleteEverything')}
                onConfirm={confirmRemoveFromDisk}
                onCancel={() => setPendingDisk(null)}
            />
        </div>
    );
}
