/**
 * Library entry cards: the grid card and the list row, with their shared
 * pieces (status badges, stat line, action menus, migration banner,
 * chapters panel). All state stays in the Library view — the cards receive
 * it through `state` / `handlers`.
 */
import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import type React from 'react';
import { useI18n } from '../../i18n/index.js';
import { chapterDownloadable } from '../../lib/chapters.js';
import type { DisplayPrefs, ViewMode } from '../../lib/library-filters.js';
import { progressOf, progressTone } from '../../lib/library-filters.js';
import { ChapterStatusBadge } from '../ChapterList.js';
import { Cover } from '../Cover.js';
import {
    IconBookmark,
    IconBookmarkFilled,
    IconCheck,
    IconDots,
    IconDownload,
    IconList,
    IconPause,
    IconPlay,
    IconRefresh,
    IconSearch,
    IconTrash,
    IconUndo,
    IconX
} from '../icons.js';
import { Badge, Button, IconButton, ProgressBar, Spinner, Toggle } from '../ui.js';

/** Interactions the cards trigger (implemented by the Library view). */
export interface EntryCardHandlers {
    onCheck(entry: LibraryEntryDto): void;
    onDownloadNew(entry: LibraryEntryDto): void;
    onToggleChapters(entry: LibraryEntryDto): void;
    onRematch(entry: LibraryEntryDto): void;
    onTogglePaused(entry: LibraryEntryDto): void;
    onUndoMigration(entry: LibraryEntryDto): void;
    onRestore(entry: LibraryEntryDto): void;
    onRemove(entry: LibraryEntryDto): void;
    onToggleFollow(entry: LibraryEntryDto, value: boolean): void;
    onConfirmMigration(entry: LibraryEntryDto, apply: boolean): void;
    onOpenSeries(id: number): void;
    onDownloadChapter(entry: LibraryEntryDto, chapter: LibraryChapterDto): void;
    onRollbackChapter(entry: LibraryEntryDto, chapter: LibraryChapterDto): void;
    onToggleSelect(id: number): void;
    onMenuFor(id: number | null): void;
}

/** Render state the cards read (owned by the Library view). */
export interface EntryCardState {
    busy: Record<string, boolean>;
    expandedId: number | null;
    chapters: LibraryChapterDto[] | null;
    selecting: boolean;
    selectedIds: Set<number>;
    showHidden: boolean;
    view: ViewMode;
    prefs: DisplayPrefs;
    menuFor: number | null;
}

interface EntryCardProps {
    entry: LibraryEntryDto;
    state: EntryCardState;
    handlers: EntryCardHandlers;
    menuRef: React.Ref<HTMLDivElement>;
    /** Long-press handlers spread on the card (selection mode entry point). */
    longPress(id: number): React.HTMLAttributes<HTMLElement>;
}

function statusBadges(entry: LibraryEntryDto, t: ReturnType<typeof useI18n>['t']) {
    return (
        <>
            {entry.newCount > 0 && <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold text-canvas shadow-lg">+{entry.newCount}</span>}
            {(entry.checkFailures ?? 0) > 0 && (
                <span className="rounded-md bg-red-500 px-1.5 py-0.5 text-[11px] font-bold text-white shadow-lg">
                    {t('library.failuresShort', { n: entry.checkFailures ?? 0 })}
                </span>
            )}
        </>
    );
}

function statLine(entry: LibraryEntryDto, prefs: DisplayPrefs, t: ReturnType<typeof useI18n>['t'], formatDate: ReturnType<typeof useI18n>['formatDate']) {
    return (
        <>
            {entry.chapterCount > 0 ? (
                <span>{t('library.chaptersRatio', { downloaded: entry.downloadedCount, total: entry.chapterCount })}</span>
            ) : (
                <span className="text-red-400">{t('library.noSourceBadge')}</span>
            )}
            {prefs.missing && (entry.missingCount ?? 0) > 0 && (
                <>
                    <span className="opacity-40">·</span>
                    <span className="text-accent-soft">{t('library.missingCount', { n: entry.missingCount ?? 0 })}</span>
                </>
            )}
            {prefs.date && entry.lastCheckedAt && (
                <>
                    <span className="opacity-40">·</span>
                    <span className="opacity-70">{t('library.seen', { date: formatDate(entry.lastCheckedAt) })}</span>
                </>
            )}
        </>
    );
}

/** Primary actions stay inline on the card; rare ones move to the overflow menu. */
function primaryActions(entry: LibraryEntryDto, state: EntryCardState, handlers: EntryCardHandlers, t: ReturnType<typeof useI18n>['t'], withChapters = true) {
    return (
        <>
            <IconButton title={t('library.check')} onClick={() => handlers.onCheck(entry)} loading={state.busy[`check-${entry.id}`]}>
                <IconRefresh size={14} />
            </IconButton>
            <IconButton
                title={t('library.downloadNew')}
                onClick={() => handlers.onDownloadNew(entry)}
                disabled={entry.newCount === 0 && (entry.failedCount ?? 0) === 0}
                loading={state.busy[`dl-${entry.id}`]}
            >
                <IconDownload size={14} />
            </IconButton>
            {withChapters && (
                <IconButton title={state.expandedId === entry.id ? t('library.hide') : t('discover.chapters')} onClick={() => handlers.onToggleChapters(entry)}>
                    <IconList size={14} />
                </IconButton>
            )}
        </>
    );
}

/** Labeled dropdown for secondary actions (rematch, undo migration, remove/restore). */
function actionMenu(
    entry: LibraryEntryDto,
    state: EntryCardState,
    handlers: EntryCardHandlers,
    menuRef: EntryCardProps['menuRef'],
    t: ReturnType<typeof useI18n>['t'],
    withChapters = false
) {
    const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false, loading = false) => (
        <button
            type="button"
            disabled={loading}
            onClick={() => {
                handlers.onMenuFor(null);
                onClick();
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors disabled:opacity-50 ${
                danger ? 'text-red-400 hover:bg-red-500/10' : 'text-fg hover:bg-card'
            }`}
        >
            <span className="flex-none">{loading ? <Spinner size={13} /> : icon}</span>
            {label}
        </button>
    );
    return (
        <div className="relative" ref={state.menuFor === entry.id ? menuRef : undefined}>
            <IconButton title={t('library.moreActions')} onClick={() => handlers.onMenuFor(state.menuFor === entry.id ? null : entry.id)}>
                <IconDots size={14} />
            </IconButton>
            {state.menuFor === entry.id && (
                <div className="absolute bottom-8 right-0 z-30 w-48 rounded-xl border border-line bg-card p-1.5 shadow-xl shadow-black/60">
                    {withChapters &&
                        item(<IconList size={14} />, state.expandedId === entry.id ? t('library.hide') : t('discover.chapters'), () =>
                            handlers.onToggleChapters(entry)
                        )}
                    {item(<IconSearch size={14} />, t('library.rematch'), () => handlers.onRematch(entry), false, state.busy[`rematch-${entry.id}`])}
                    {item(
                        entry.paused ? <IconPlay size={14} /> : <IconPause size={14} />,
                        entry.paused ? t('library.resumeFollow') : t('library.pauseFollow'),
                        () => handlers.onTogglePaused(entry)
                    )}
                    {entry.canRollbackMigration && item(<IconUndo size={14} />, t('library.rollbackMigrationHint'), () => handlers.onUndoMigration(entry))}
                    <div className="my-1 border-t border-line" />
                    {state.showHidden
                        ? item(<IconRefresh size={14} />, t('library.reestablish'), () => handlers.onRestore(entry))
                        : item(<IconTrash size={14} />, t('library.remove'), () => handlers.onRemove(entry), true)}
                </div>
            )}
        </div>
    );
}

/** List rows have room: everything stays inline. */
function secondaryActions(entry: LibraryEntryDto, state: EntryCardState, handlers: EntryCardHandlers, t: ReturnType<typeof useI18n>['t']) {
    return (
        <>
            <IconButton title={t('library.rematchHint')} onClick={() => handlers.onRematch(entry)} loading={state.busy[`rematch-${entry.id}`]}>
                <IconSearch size={14} />
            </IconButton>
            <IconButton title={entry.paused ? t('library.resumeFollow') : t('library.pauseFollow')} onClick={() => handlers.onTogglePaused(entry)}>
                {entry.paused ? <IconPlay size={14} /> : <IconPause size={14} />}
            </IconButton>
            {entry.canRollbackMigration && (
                <IconButton title={t('library.rollbackMigrationHint')} onClick={() => handlers.onUndoMigration(entry)}>
                    <IconUndo size={14} />
                </IconButton>
            )}
            {state.showHidden ? (
                <IconButton title={t('library.reestablish')} onClick={() => handlers.onRestore(entry)}>
                    <IconRefresh size={14} />
                </IconButton>
            ) : (
                <IconButton title={t('library.remove')} variant="danger" onClick={() => handlers.onRemove(entry)}>
                    <IconTrash size={14} />
                </IconButton>
            )}
        </>
    );
}

function migrationBanner(entry: LibraryEntryDto, handlers: EntryCardHandlers, t: ReturnType<typeof useI18n>['t'], className = '') {
    return (
        entry.migrationSuggestion && (
            <div className={`flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-xs ${className}`}>
                <span className="text-fg">
                    {t('library.migrationSuggested')} <b>{entry.migrationSuggestion.mangaTitle}</b> ({entry.migrationSuggestion.sourceLabel},{' '}
                    {Math.round((entry.migrationSuggestion.score ?? 0) * 100)}%)
                </span>
                <Button small onClick={() => handlers.onConfirmMigration(entry, true)}>
                    {t('library.migrate')}
                </Button>
                <Button small variant="ghost" onClick={() => handlers.onConfirmMigration(entry, false)}>
                    <IconX size={12} />
                </Button>
            </div>
        )
    );
}

function chaptersPanel(entry: LibraryEntryDto, state: EntryCardState, handlers: EntryCardHandlers, t: ReturnType<typeof useI18n>['t'], className = '') {
    return (
        state.expandedId === entry.id && (
            <div className={`max-h-56 space-y-1 overflow-y-auto rounded-xl bg-canvas/60 p-2 ${className}`}>
                {state.chapters === null && (
                    <div className="p-2 text-sm text-faint">
                        <Spinner />
                    </div>
                )}
                {state.chapters?.map(chapter => (
                    <div key={chapter.id} className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
                        <span className="truncate text-fg" title={chapter.path || ''}>
                            {chapter.title}
                        </span>
                        <span className="flex items-center gap-1.5">
                            {chapterDownloadable(chapter.status) && (
                                <button
                                    type="button"
                                    title={chapter.status === 'failed' ? t('library.retryChapterHint') : t('library.downloadChapterHint')}
                                    onClick={() => handlers.onDownloadChapter(entry, chapter)}
                                    className="text-faint transition-colors hover:text-accent-soft"
                                >
                                    <IconDownload size={13} />
                                </button>
                            )}
                            {(chapter.historyCount ?? 0) > 0 && (
                                <button
                                    type="button"
                                    title={t('library.restoreFileHint')}
                                    onClick={() => handlers.onRollbackChapter(entry, chapter)}
                                    className="text-faint transition-colors hover:text-accent-soft"
                                >
                                    <IconUndo size={13} />
                                </button>
                            )}
                            <ChapterStatusBadge chapter={chapter} />
                        </span>
                    </div>
                ))}
            </div>
        )
    );
}

/** Top-right cover button: selection toggle while selecting, follow toggle otherwise. */
function coverCornerButton(entry: LibraryEntryDto, state: EntryCardState, handlers: EntryCardHandlers, t: ReturnType<typeof useI18n>['t']) {
    const active = state.selecting ? state.selectedIds.has(entry.id) : entry.autoDownload;
    const onClick = state.selecting ? () => handlers.onToggleSelect(entry.id) : () => handlers.onToggleFollow(entry, !entry.autoDownload);
    const title = state.selecting ? entry.title : t(entry.autoDownload ? 'library.following' : 'library.manualDl');
    let icon: React.ReactNode;
    if (state.selecting) {
        icon = state.selectedIds.has(entry.id) ? <IconCheck size={13} /> : <IconBookmark size={13} />;
    } else {
        icon = entry.autoDownload ? <IconBookmarkFilled size={13} /> : <IconBookmark size={13} />;
    }
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onClick={onClick}
            className={`absolute right-2.5 top-2.5 rounded-lg border border-line bg-canvas/80 p-1.5 backdrop-blur transition-colors ${
                active ? 'text-accent-soft' : 'text-muted hover:text-fg'
            }`}
        >
            {icon}
        </button>
    );
}

export function EntryGridCard({ entry, state, handlers, menuRef, longPress }: EntryCardProps) {
    const { t, formatDate } = useI18n();
    const progress = progressOf(entry);
    const tone = progressTone(entry);
    return (
        <article
            {...longPress(entry.id)}
            className={`group relative rounded-2xl border bg-surface transition-all duration-200 hover:-translate-y-1 hover:border-faint hover:shadow-xl hover:shadow-black/50 ${
                state.selecting && state.selectedIds.has(entry.id) ? 'border-accent/60 ring-1 ring-accent/40' : 'border-line'
            }`}
        >
            <div className="relative aspect-[2/3] overflow-hidden rounded-t-2xl">
                <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="absolute inset-0 h-full w-full" />
                {/* full-cover click target (pointer + keyboard): opens the series (or toggles selection) */}
                <button
                    type="button"
                    title={entry.title}
                    aria-label={entry.title}
                    onClick={() => (state.selecting ? handlers.onToggleSelect(entry.id) : handlers.onOpenSeries(entry.id))}
                    className="absolute inset-0"
                />
                <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-col items-start gap-1">{statusBadges(entry, t)}</div>
                {coverCornerButton(entry, state, handlers, t)}
                {/* scrim: title + stats overlaid on the cover */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-3.5 pb-2.5 pt-12">
                    <div className="line-clamp-2 font-display text-[15px] font-bold leading-snug text-white">{entry.title}</div>
                    <div className="mt-1 flex items-end justify-between gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] font-medium text-white/60">
                            {statLine(entry, state.prefs, t, formatDate)}
                            {entry.paused && (
                                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                    {t('library.paused')}
                                </span>
                            )}
                        </div>
                        {/* primary actions overlaid on the cover: hover-revealed on desktop, always visible on touch */}
                        <div className="card-actions pointer-events-auto -mr-1 flex flex-none items-center gap-0.5">
                            {primaryActions(entry, state, handlers, t, state.view !== 'grid-compact')}
                        </div>
                    </div>
                    {state.prefs.progress && (
                        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/15">
                            <div
                                className={`h-full rounded-full transition-all duration-300 ${tone === 'green' ? 'bg-emerald-400' : 'bg-accent'}`}
                                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                            />
                        </div>
                    )}
                </div>
            </div>
            <div className="space-y-1.5 p-3">
                <div className="flex items-center justify-between gap-2">
                    {state.prefs.source &&
                        (entry.sourceLabel ? (
                            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-widest text-faint">{entry.sourceLabel}</span>
                        ) : (
                            <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-widest text-red-400">
                                {t('library.noSourceBadge')}
                            </span>
                        ))}
                    <div className="ml-auto flex flex-none items-center">{actionMenu(entry, state, handlers, menuRef, t, state.view === 'grid-compact')}</div>
                </div>
                {migrationBanner(entry, handlers, t)}
                {chaptersPanel(entry, state, handlers, t)}
            </div>
        </article>
    );
}

export function EntryListRow({ entry, state, handlers, longPress }: EntryCardProps) {
    const { t, formatDate } = useI18n();
    return (
        <article
            {...longPress(entry.id)}
            className={`rounded-2xl border bg-surface p-2.5 transition-colors hover:border-faint ${
                state.selecting && state.selectedIds.has(entry.id) ? 'border-accent/60 ring-1 ring-accent/40' : 'border-line'
            }`}
        >
            <div className="flex items-center gap-3">
                {state.selecting && (
                    <input
                        type="checkbox"
                        checked={state.selectedIds.has(entry.id)}
                        onChange={() => handlers.onToggleSelect(entry.id)}
                        aria-label={entry.title}
                        className="flex-none accent-accent"
                    />
                )}
                <button
                    type="button"
                    title={entry.title}
                    aria-label={entry.title}
                    onClick={() => (state.selecting ? handlers.onToggleSelect(entry.id) : handlers.onOpenSeries(entry.id))}
                    tabIndex={-1}
                    className="flex-none"
                >
                    <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="h-16 w-11 rounded-lg" />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            className="truncate font-display text-sm font-semibold tracking-tight transition-colors hover:text-accent-soft"
                            title={entry.title}
                            onClick={() => (state.selecting ? handlers.onToggleSelect(entry.id) : handlers.onOpenSeries(entry.id))}
                        >
                            {entry.title}
                        </button>
                        {statusBadges(entry, t)}
                        {entry.paused && <Badge>{t('library.paused')}</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted">
                        {state.prefs.source && (
                            <>
                                {entry.sourceLabel ? (
                                    <span className="font-medium uppercase tracking-wide text-faint">{entry.sourceLabel}</span>
                                ) : (
                                    <span className="text-red-400">{t('library.noSourceBadge')}</span>
                                )}
                                <span className="text-faint">·</span>
                            </>
                        )}
                        {statLine(entry, state.prefs, t, formatDate)}
                    </div>
                </div>
                {state.prefs.progress && (
                    <div className="hidden w-32 flex-none sm:block">
                        <div className="mb-1 text-right text-[11px] text-muted">{Math.round(progressOf(entry))}%</div>
                        <ProgressBar value={progressOf(entry)} tone={progressTone(entry)} />
                    </div>
                )}
                <Toggle
                    checked={entry.autoDownload}
                    onChange={value => handlers.onToggleFollow(entry, value)}
                    label={entry.autoDownload ? t('library.following') : t('library.manualDl')}
                />
                <div className="card-actions flex flex-none items-center gap-1">
                    {primaryActions(entry, state, handlers, t)}
                    {secondaryActions(entry, state, handlers, t)}
                </div>
            </div>
            {migrationBanner(entry, handlers, t, 'mt-2')}
            {chaptersPanel(entry, state, handlers, t, 'mt-2')}
        </article>
    );
}
