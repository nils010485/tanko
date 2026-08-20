/**
 * Shared chapter / rematch helpers used by the Library and Series views.
 */
import type { LibraryChapterDto } from '@tanko/shared';

/** Chapters that can be (re)queued through the ad-hoc download endpoint. */
export function chapterDownloadable(status: LibraryChapterDto['status']): boolean {
    switch (status) {
        case 'new':
        case 'missing':
        case 'failed':
            return true;
        default:
            return false;
    }
}

/** Map tracked chapters onto the ad-hoc /api/downloads payload shape. */
export function toQueueChapters(chapters: LibraryChapterDto[]): Array<{ id: string; title: string }> {
    return chapters.map(chapter => ({ id: chapter.chapterId, title: chapter.title }));
}

/** i18n key describing a re-match outcome (extra interpolation params are ignored). */
export function rematchOutcomeKey(outcome: string): 'library.migratedTo' | 'library.migrationSuggestedToast' | 'library.noAlternateSource' {
    switch (outcome) {
        case 'migrated':
            return 'library.migratedTo';
        case 'suggested':
            return 'library.migrationSuggestedToast';
        default:
            return 'library.noAlternateSource';
    }
}
