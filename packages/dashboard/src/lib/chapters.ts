/**
 * Shared chapter / rematch helpers used by the Library and Series views.
 */
import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { api } from './api.js';

/** Chapters that can be (re)queued through the ad-hoc download endpoint
 *  ('lost' included: the user may know better than the source's listing). */
export function chapterDownloadable(status: LibraryChapterDto['status']): boolean {
    switch (status) {
        case 'new':
        case 'missing':
        case 'failed':
        case 'lost':
            return true;
        default:
            return false;
    }
}

/** Map tracked chapters onto the ad-hoc /api/downloads payload shape.
 *  Local-only chapters (no source counterpart) are dropped: the source
 *  has nothing to download for them. */
export function toQueueChapters(chapters: LibraryChapterDto[]): Array<{ id: string; title: string }> {
    return chapters.filter(chapter => !chapter.localOnly).map(chapter => ({ id: chapter.chapterId, title: chapter.title }));
}

/** i18n key of a chapter status badge: 'failed' splits by ladder state so a
 *  slow-revalidation chapter reads differently from a fresh failure. */
export function chapterStatusKey(chapter: LibraryChapterDto): `library.chapterStatus.${LibraryChapterDto['status']}` | 'library.chapterStatus.failedExhausted' {
    return chapter.status === 'failed' && chapter.retryExhausted ? 'library.chapterStatus.failedExhausted' : `library.chapterStatus.${chapter.status}`;
}

/** Tooltip key explaining a non-obvious chapter state (no tooltip otherwise). */
export function chapterStatusHint(chapter: LibraryChapterDto): 'library.chapterLostHint' | 'library.chapterExhaustedHint' | undefined {
    if (chapter.status === 'lost') {
        return 'library.chapterLostHint';
    }
    return chapter.status === 'failed' && chapter.retryExhausted ? 'library.chapterExhaustedHint' : undefined;
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

/** Queue chapters of a library entry through the ad-hoc /api/downloads
 *  endpoint (single chapter, selection, or pending chapters). */
export function enqueueEntryChapters(
    entry: Pick<LibraryEntryDto, 'sourceId' | 'mangaId' | 'title'>,
    chapters: LibraryChapterDto[]
): Promise<{ added: number; skipped: number; retried: number }> {
    return api.enqueue({
        sourceId: entry.sourceId,
        mangaId: entry.mangaId,
        mangaTitle: entry.title,
        chapters: toQueueChapters(chapters)
    });
}
