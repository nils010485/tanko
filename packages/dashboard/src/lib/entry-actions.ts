import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import type { ToastApi } from '../components/toast.js';
import type { TFunction } from '../i18n/index.js';
import { api } from './api.js';
import { enqueueEntryChapters, rematchOutcomeKey } from './chapters.js';

export type EntryRef = Pick<LibraryEntryDto, 'id' | 'title'>;

export interface EntryActionsDeps {
    t: TFunction;
    toast: ToastApi;
    refreshLibrary: () => Promise<void>;
    setBusy: (key: string, value: boolean) => void;
    reloadChapters: (entryId: number) => Promise<void>;
    notifyDownloadNew?: (queued: number) => void;
}

export function createEntryActions(deps: EntryActionsDeps) {
    async function run(busyKey: string | undefined, task: () => Promise<void>): Promise<boolean> {
        if (busyKey !== undefined) {
            deps.setBusy(busyKey, true);
        }
        try {
            await task();
            return true;
        } catch (error) {
            deps.toast.error((error as Error).message);
            return false;
        } finally {
            if (busyKey !== undefined) {
                deps.setBusy(busyKey, false);
            }
        }
    }

    return {
        checkEntry: (entry: EntryRef, busyKey?: string) =>
            run(busyKey, async () => {
                const result = await api.checkEntry(entry.id);
                deps.toast.info(
                    result.newChapters > 0
                        ? deps.t('library.newChapters', { n: result.newChapters, title: entry.title })
                        : deps.t('library.upToDate', { title: entry.title })
                );
                await deps.refreshLibrary();
                await deps.reloadChapters(entry.id);
            }),

        downloadNew: (entry: EntryRef, busyKey?: string) =>
            run(busyKey, async () => {
                const result = await api.downloadNew(entry.id);
                deps.notifyDownloadNew?.(result.queued);
                await deps.refreshLibrary();
                await deps.reloadChapters(entry.id);
            }),

        rematch: (entry: EntryRef, busyKey?: string) =>
            run(busyKey, async () => {
                const result = await api.rematchEntry(entry.id);
                deps.toast.info(deps.t(rematchOutcomeKey(result.outcome), { title: entry.title, source: result.entry?.sourceLabel ?? '' }));
                await deps.refreshLibrary();
            }),

        confirmMigration: (entry: EntryRef, apply: boolean) =>
            run(undefined, async () => {
                const result = await api.confirmRematch(entry.id, apply);
                if (apply) {
                    deps.toast.success(deps.t('library.migratedKept', { title: entry.title, kept: result.kept ?? 0, total: result.total ?? 0 }));
                }
                await deps.refreshLibrary();
            }),

        undoMigration: (entry: EntryRef) =>
            run(undefined, async () => {
                await api.rollbackMigration(entry.id);
                deps.toast.success(deps.t('library.migrationUndone', { title: entry.title }));
                await deps.refreshLibrary();
            }),

        togglePaused: (entry: EntryRef & { paused?: boolean }) =>
            run(undefined, async () => {
                await api.setPaused(entry.id, !entry.paused);
                deps.toast.success(deps.t(entry.paused ? 'library.resumedToast' : 'library.pausedToast', { title: entry.title }));
                await deps.refreshLibrary();
            }),

        downloadChapter: (entry: LibraryEntryDto, chapter: LibraryChapterDto) =>
            run(undefined, async () => {
                await enqueueEntryChapters(entry, [chapter]);
                deps.toast.success(deps.t('library.chapterQueued', { chapter: chapter.title }));
                await deps.reloadChapters(entry.id);
            }),

        rollbackChapter: (entry: EntryRef, chapter: LibraryChapterDto) =>
            run(undefined, async () => {
                await api.rollbackChapter(entry.id, chapter.chapterId);
                deps.toast.success(deps.t('library.chapterRestored', { chapter: chapter.title }));
                await deps.reloadChapters(entry.id);
            })
    };
}
