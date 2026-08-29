/**
 * Series view (Sonarr-style): one page per tracked series — status, follow
 * toggle, check / download actions and the full chapter list with per-chapter
 * download, retry, preview and restore. Reached via #/library/:id.
 */
import type { LibraryChapterDto, LibraryEntryDto, SourceAlternativeDto, SourceAlternativesResponseDto } from '@tanko/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChapterList, ChapterStatusBadge } from '../components/ChapterList.js';
import { Cover } from '../components/Cover.js';
import { ConfirmDialog } from '../components/confirm.js';
import {
    IconArrowLeft,
    IconArrowLeftRight,
    IconDownload,
    IconEye,
    IconGlobe,
    IconLibrary,
    IconRefresh,
    IconSearch,
    IconUndo,
    IconX
} from '../components/icons.js';
import { PagePreview } from '../components/PagePreview.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, IconButton, Input, SectionTitle, Spinner, Toggle } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { chapterDownloadable, rematchOutcomeKey, toQueueChapters } from '../lib/chapters.js';
import { useEscapeKey } from '../lib/hooks.js';

interface PreviewState {
    title: string;
    pages: string[] | null;
    loading: boolean;
    error: string;
}

/** Entries with at most this many chapters get the "starved source" badge
 *  (mirrors INCOMPLETE_SOURCE_CHAPTERS on the server). */
const INCOMPLETE_BADGE_CHAPTERS = 10;

/** Chapter-list order, persisted across sessions ('asc' keeps the source order). */
const CHAPTERS_SORT_KEY = 'tanko.series.chaptersSort';
type ChapterSort = 'asc' | 'desc';
const readChapterSort = (): ChapterSort => (localStorage.getItem(CHAPTERS_SORT_KEY) === 'desc' ? 'desc' : 'asc');

export default function Series({
    entryId,
    library,
    libraryLoaded,
    onBack,
    refreshLibrary
}: {
    entryId: number;
    library: LibraryEntryDto[];
    libraryLoaded: boolean;
    onBack: () => void;
    refreshLibrary: () => Promise<void>;
}) {
    const entry = library.find(item => item.id === entryId);
    const [chapters, setChapters] = useState<LibraryChapterDto[] | null>(null);
    const [chapterQuery, setChapterQuery] = useState('');
    const [chapterSort, setChapterSort] = useState<ChapterSort>(readChapterSort);

    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [preview, setPreview] = useState<PreviewState | null>(null);
    const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
    const [missingDialog, setMissingDialog] = useState(false);
    const toast = useToast();
    /** Source picker dialog: alternatives with chapter counts. */
    const [picker, setPicker] = useState<{ open: boolean; loading: boolean; error: string; data: SourceAlternativesResponseDto | null }>({
        open: false,
        loading: false,
        error: '',
        data: null
    });
    /** sourceId of the alternative being migrated to (row-level loading). */
    const [migratingTo, setMigratingTo] = useState<string | null>(null);
    /** Alias-editor input in the source picker. */
    const [aliasInput, setAliasInput] = useState('');
    const { t, formatDate } = useI18n();
    /** Ignore responses that resolve after a newer fetch started (series switch, poll, refresh). */
    const requestSeq = useRef(0);

    useEffect(() => {
        localStorage.setItem(CHAPTERS_SORT_KEY, chapterSort);
    }, [chapterSort]);

    // filtered + reordered view of the chapter list (search box + sort toggle)
    const visibleChapters = useMemo(() => {
        const list = chapters ?? [];
        const needle = chapterQuery.trim().toLowerCase();
        const filtered = needle === '' ? list : list.filter(chapter => chapter.title.toLowerCase().includes(needle));
        return chapterSort === 'asc' ? filtered : [...filtered].reverse();
    }, [chapters, chapterQuery, chapterSort]);
    const loadChapters = useCallback(async () => {
        const seq = ++requestSeq.current;
        try {
            const list = await api.entryChapters(entryId);
            if (requestSeq.current === seq) {
                setChapters(list);
            }
        } catch {
            if (requestSeq.current === seq) {
                setChapters([]);
            }
        }
    }, [entryId]);

    // switching series restarts from a clean slate
    useEffect(() => {
        setChapters(null);
        setChapterQuery('');
        setSelectedChapters(new Set());
        setPreview(null);
        setBusy({});
        void loadChapters();
    }, [loadChapters]);

    // poll while a chapter of this series is in flight so statuses follow job completions
    const jobsActive = chapters?.some(chapter => chapter.status === 'queued' || chapter.status === 'downloading') ?? false;
    useEffect(() => {
        if (!jobsActive) return;
        const timer = setInterval(() => void loadChapters(), 4000);
        return () => clearInterval(timer);
    }, [jobsActive, loadChapters]);

    useEscapeKey(() => setPreview(null), preview !== null);
    useEscapeKey(() => setPicker(current => ({ ...current, open: false })), picker.open);

    const setBusyFlag = (key: string, value: boolean) => setBusy(current => ({ ...current, [key]: value }));

    const checkNow = async () => {
        setBusyFlag('check', true);
        try {
            const result = await api.checkEntry(entryId);
            const title = entry?.title ?? '';
            toast.info(result.newChapters > 0 ? t('library.newChapters', { n: result.newChapters, title }) : t('library.upToDate', { title }));
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag('check', false);
        }
    };

    const downloadNewChapters = async () => {
        setBusyFlag('dlNew', true);
        try {
            const result = await api.downloadNew(entryId);
            toast.success(t('series.chaptersQueued', { n: result.queued }));
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag('dlNew', false);
        }
    };

    /** Sonarr-style single action: grab everything not on disk yet ('new' +
     *  'missing' + 'failed'). Chapters that predate the follow ('missing')
     *  ask first — the confirm dialog is the monitor-only guard a 500-chapter
     *  backlog needs. */
    const downloadMissing = async () => {
        if (!entry) return;
        if (missingOnly === 0) {
            await downloadNewChapters();
            return;
        }
        setMissingDialog(true);
    };

    /** Everything not on disk: 'new' + 'missing' + 'failed' via the ad-hoc
     *  enqueue endpoint (the scheduler's fresh-only semantics stay untouched). */
    const downloadEverything = async () => {
        if (!entry) return;
        const pending = toQueueChapters(
            (chapters ?? []).filter(chapter => chapter.status === 'new' || chapter.status === 'missing' || chapter.status === 'failed')
        );
        if (pending.length === 0) return;
        setBusyFlag('dlMissing', true);
        try {
            const result = await api.enqueue({ sourceId: entry.sourceId, mangaId: entry.mangaId, mangaTitle: entry.title, chapters: pending });
            toast.success(t('series.chaptersQueued', { n: result.added + result.retried }));
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag('dlMissing', false);
        }
    };

    const rematch = async () => {
        if (!entry) return;
        setBusyFlag('rematch', true);
        try {
            const result = await api.rematchEntry(entryId);
            toast.info(t(rematchOutcomeKey(result.outcome), { title: entry.title, source: result.entry?.sourceLabel ?? '' }));
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag('rematch', false);
        }
    };

    /** Open the manual source picker: same series on the other sources, with
     *  chapter counts so a starved current source is obvious. */
    const openPicker = async () => {
        setPicker({ open: true, loading: true, error: '', data: null });
        try {
            const data = await api.entryAlternatives(entryId);
            setPicker({ open: true, loading: false, error: '', data });
            // names were auto-merged from AniList after an empty crawl: refresh so the alias chips show them
            if (data.autoAliases) {
                await refreshLibrary();
            }
        } catch (error) {
            setPicker({ open: true, loading: false, error: (error as Error).message, data: null });
        }
    };

    const closePicker = () => setPicker(current => ({ ...current, open: false }));

    /** Save the alias list, refresh the entry, then re-run the source search —
     *  editing a name only ever aims at finding more sources. */
    const saveAliases = async (aliases: string[]) => {
        try {
            await api.updateAliases(entryId, aliases);
            await refreshLibrary();
            await openPicker();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const addAlias = async () => {
        const alias = aliasInput.trim();
        if (!entry || alias === '') {
            return;
        }
        setAliasInput('');
        await saveAliases([...(entry.aliases ?? []), alias]);
    };

    /** Merge AniList's official + alternative titles into the aliases. */
    const fetchAliasesFromAniList = async () => {
        setBusyFlag('aliasFetch', true);
        try {
            const result = await api.fetchAliases(entryId);
            await refreshLibrary();
            toast.info(result.fetched.length > 0 ? t('series.aliasFetched', { n: result.fetched.length }) : t('series.aliasFetchEmpty'));
            await openPicker();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusyFlag('aliasFetch', false);
        }
    };

    const migrateTo = async (target: SourceAlternativeDto) => {
        setMigratingTo(target.sourceId);
        try {
            const result = await api.migrateToSource(entryId, target);
            toast.success(t('library.migratedKept', { title: entry?.title ?? '', kept: result.kept, total: result.total }));
            closePicker();
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setMigratingTo(null);
        }
    };

    /** Apply or dismiss the pending migration suggestion (banner). */
    const confirmMigration = async (apply: boolean) => {
        try {
            const result = await api.confirmRematch(entryId, apply);
            if (apply) {
                toast.success(t('library.migratedKept', { title: entry?.title ?? '', kept: result.kept ?? 0, total: result.total ?? 0 }));
            }
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const undoMigration = async () => {
        try {
            await api.rollbackMigration(entryId);
            toast.success(t('library.rollbackMigrationDone'));
            await refreshLibrary();
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };
    const toggleFollow = async (value: boolean) => {
        try {
            await api.setAutoDownload(entryId, value);
            await refreshLibrary();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const downloadChapter = async (chapter: LibraryChapterDto) => {
        if (!entry) return;
        try {
            await api.enqueue({
                sourceId: entry.sourceId,
                mangaId: entry.mangaId,
                mangaTitle: entry.title,
                chapters: toQueueChapters([chapter])
            });
            toast.success(t('library.chapterQueued', { chapter: chapter.title }));
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    /** Queue every selected chapter (checkbox / shift-range selection). */
    const downloadSelected = async () => {
        if (!entry) return;
        const picked = (chapters ?? []).filter(chapter => selectedChapters.has(String(chapter.id)));
        if (picked.length === 0) return;
        try {
            const result = await api.enqueue({
                sourceId: entry.sourceId,
                mangaId: entry.mangaId,
                mangaTitle: entry.title,
                chapters: toQueueChapters(picked)
            });
            toast.success(t('series.chaptersQueued', { n: result.added + result.retried }));
            setSelectedChapters(new Set());
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const rollbackChapter = async (chapter: LibraryChapterDto) => {
        try {
            await api.rollbackChapter(entryId, chapter.chapterId);
            toast.success(t('library.chapterRestored', { chapter: chapter.title }));
            await loadChapters();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const openPreview = async (chapter: LibraryChapterDto) => {
        if (!entry) return;
        setPreview({ title: chapter.title, pages: null, loading: true, error: '' });
        try {
            const result = await api.pages(entry.sourceId, entry.mangaId, chapter.chapterId, entry.title, chapter.title);
            setPreview({ title: chapter.title, pages: result.pages || [], loading: false, error: '' });
        } catch (error) {
            setPreview({ title: chapter.title, pages: [], loading: false, error: (error as Error).message });
        }
    };

    if (!entry) {
        return (
            <div className="space-y-6">
                <div>
                    <Button small variant="ghost" onClick={onBack}>
                        <IconArrowLeft size={14} /> {t('series.back')}
                    </Button>
                </div>
                {libraryLoaded ? (
                    <EmptyState title={t('series.notFound')} hint={t('series.notFoundHint')} icon={<IconLibrary size={28} />} />
                ) : (
                    <Card className="flex items-center gap-2 p-4 text-sm text-zinc-500">
                        <Spinner /> {t('common.loading')}
                    </Card>
                )}
            </div>
        );
    }

    const missingOnly = chapters?.filter(chapter => chapter.status === 'missing').length ?? 0;
    const failedCount = chapters?.filter(chapter => chapter.status === 'failed').length ?? 0;
    // the single Sonarr-style action grabs everything not on disk yet
    const pendingCount = (chapters?.filter(chapter => chapter.status === 'new').length ?? 0) + missingOnly + failedCount;

    const chapterNode = (chapter: LibraryChapterDto) => (
        <span className="flex flex-none items-center gap-1.5">
            {!chapter.localOnly && (
                <IconButton title={t('discover.previewHint')} onClick={() => openPreview(chapter)}>
                    <IconEye size={14} />
                </IconButton>
            )}
            {chapterDownloadable(chapter.status) && !chapter.localOnly && (
                <IconButton
                    title={chapter.status === 'failed' ? t('library.retryChapterHint') : t('library.downloadChapterHint')}
                    onClick={() => downloadChapter(chapter)}
                >
                    <IconDownload size={13} />
                </IconButton>
            )}
            {(chapter.historyCount ?? 0) > 0 && (
                <IconButton title={t('library.restoreFileHint')} onClick={() => rollbackChapter(chapter)}>
                    <span className="text-sm">⟲</span>
                </IconButton>
            )}
            {chapter.localOnly && (
                <span title={t('library.localOnlyChapterHint')}>
                    <Badge tone="blue">{t('library.localOnlyChapter')}</Badge>
                </span>
            )}
            <ChapterStatusBadge chapter={chapter} />
        </span>
    );

    return (
        <div className="space-y-6">
            <div>
                <Button small variant="ghost" onClick={onBack}>
                    <IconArrowLeft size={14} /> {t('series.back')}
                </Button>
            </div>

            <Card className="flex flex-col gap-4 p-4 sm:flex-row">
                <Cover title={entry.title} thumbnail={entry.thumbnail} coverUrl={entry.coverUrl} className="h-40 w-28 flex-none rounded-lg" />
                <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold" title={entry.title}>
                            {entry.title}
                        </h2>
                        {entry.newCount > 0 && <Badge tone="orange">+{entry.newCount}</Badge>}
                        {entry.sourceLabel ? <Badge>{entry.sourceLabel}</Badge> : <Badge tone="red">{t('library.noSourceBadge')}</Badge>}
                        {entry.chapterCount > 0 && entry.chapterCount <= INCOMPLETE_BADGE_CHAPTERS && (
                            <button type="button" onClick={openPicker} title={t('series.changeSourceHint')}>
                                <Badge tone="orange">{t('series.incompleteBadge', { n: entry.chapterCount })}</Badge>
                            </button>
                        )}
                        {entry.paused && <Badge>{t('library.paused')}</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                        {entry.chapterCount > 0 && <span>{t('library.chaptersRatio', { downloaded: entry.downloadedCount, total: entry.chapterCount })}</span>}
                        {missingOnly > 0 && <span className="text-accent-soft">{t('library.missingCount', { n: missingOnly })}</span>}
                        {entry.lastCheckedAt && <span className="text-faint">{t('library.seen', { date: formatDate(entry.lastCheckedAt) })}</span>}
                        {entry.lastChapterAt && <span className="text-faint">{t('library.lastChapterAt', { date: formatDate(entry.lastChapterAt) })}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {/* suivi + téléchargements */}
                        <Toggle
                            checked={entry.autoDownload}
                            onChange={toggleFollow}
                            label={entry.autoDownload ? t('library.following') : t('library.manualDl')}
                        />
                        <Button small onClick={checkNow} loading={busy.check}>
                            <IconRefresh size={13} /> {t('library.check')}
                        </Button>
                        <Button
                            small
                            onClick={downloadMissing}
                            disabled={pendingCount === 0}
                            loading={busy.dlMissing}
                            title={t('series.downloadMissingHint', { n: pendingCount })}
                        >
                            <IconDownload size={13} /> {t('series.downloadMissing')}
                            {pendingCount > 0 ? ` (${pendingCount})` : ''}
                        </Button>
                        {/* gestion de la source */}
                        <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
                        <Button small variant="ghost" onClick={rematch} loading={busy.rematch} title={t('library.rematchHint')}>
                            <IconSearch size={13} /> {t('library.rematch')}
                        </Button>
                        <Button small variant="ghost" onClick={openPicker} title={t('series.changeSourceHint')}>
                            <IconGlobe size={13} /> {t('series.changeSource')}
                        </Button>
                        {entry.canRollbackMigration && (
                            <Button small variant="ghost" onClick={undoMigration} title={t('library.rollbackMigrationHint')}>
                                <IconUndo size={13} /> {t('library.rollbackMigration')}
                            </Button>
                        )}
                    </div>
                </div>
            </Card>

            {entry.migrationSuggestion && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 px-3 py-2 text-xs">
                    <span className="text-zinc-300">
                        {t('library.migrationSuggested')} <b>{entry.migrationSuggestion.mangaTitle}</b> ({entry.migrationSuggestion.sourceLabel},{' '}
                        {Math.round((entry.migrationSuggestion.score ?? 0) * 100)}%)
                        {(entry.migrationSuggestion.chapterCount ?? 0) > 0 && (
                            <span className="text-emerald-400"> · {t('library.chaptersCount', { n: entry.migrationSuggestion.chapterCount ?? 0 })}</span>
                        )}
                    </span>
                    <Button small onClick={() => confirmMigration(true)}>
                        {t('library.migrate')}
                    </Button>
                    <Button small variant="ghost" onClick={() => confirmMigration(false)}>
                        {t('common.cancel')}
                    </Button>
                </div>
            )}
            <SectionTitle
                right={
                    selectedChapters.size > 0 && (
                        <Button small onClick={downloadSelected}>
                            <IconDownload size={13} /> {t('series.downloadSelection', { n: selectedChapters.size })}
                        </Button>
                    )
                }
            >
                {t('series.chaptersTitle')}
            </SectionTitle>
            {chapters !== null && chapters.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Input value={chapterQuery} onChange={setChapterQuery} placeholder={t('series.filterPlaceholder')} className="w-44" />
                    <Button small variant="ghost" onClick={() => setChapterSort(current => (current === 'asc' ? 'desc' : 'asc'))} title={t('series.sortHint')}>
                        <IconArrowLeftRight size={13} />
                        {chapterSort === 'asc' ? t('series.sortNewestFirst') : t('series.sortOldestFirst')}
                    </Button>
                </div>
            )}
            {chapters === null ? (
                <Card className="flex items-center gap-2 p-4 text-sm text-zinc-500">
                    <Spinner /> {t('common.loading')}
                </Card>
            ) : chapters.length === 0 ? (
                <EmptyState title={t('discover.noChapter')} />
            ) : visibleChapters.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-6 py-8 text-center text-sm text-zinc-500">{t('series.filterNoMatch')}</div>
            ) : (
                <ChapterList
                    items={visibleChapters.map(chapter => ({ key: String(chapter.id), title: chapter.title, node: chapterNode(chapter) }))}
                    selection={{ selected: selectedChapters, onChange: setSelectedChapters }}
                    resetKey={entryId}
                />
            )}

            <PagePreview
                open={preview !== null}
                title={preview?.title ?? ''}
                pages={preview?.pages ?? null}
                loading={preview?.loading ?? false}
                error={preview?.error ?? ''}
                sourceId={entry.sourceId}
                onClose={() => setPreview(null)}
            />

            {picker.open && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (useEscapeKey below)
                <div
                    className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={event => {
                        if (event.target === event.currentTarget) closePicker();
                    }}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('series.changeSource')}
                        className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="break-words text-sm font-semibold text-fg">{t('series.changeSource')}</div>
                            <IconButton title={t('common.close')} onClick={closePicker}>
                                <IconX size={14} />
                            </IconButton>
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                            {entry.sourceLabel} · {t('library.chaptersCount', { n: entry.chapterCount })} ({t('series.changeSourceCurrent')})
                        </div>

                        {/* alias editor: the other names the failover searches too (AniList or manual) */}
                        <div className="mt-3 rounded-lg border border-line bg-zinc-950/50 p-3">
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-xs text-zinc-500">{t('series.aliases')}:</span>
                                {(entry.aliases ?? []).map(alias => (
                                    <button
                                        key={alias}
                                        type="button"
                                        onClick={() => void saveAliases((entry.aliases ?? []).filter(item => item !== alias))}
                                        title={t('series.aliasRemoveHint')}
                                        className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-zinc-300 transition-colors hover:border-red-500/50 hover:text-red-400"
                                    >
                                        {alias} <IconX size={10} />
                                    </button>
                                ))}
                                <Button small variant="ghost" onClick={fetchAliasesFromAniList} loading={busy.aliasFetch} title={t('series.aliasFetchHint')}>
                                    {t('series.aliasFetch')}
                                </Button>
                            </div>
                            <form
                                className="mt-2 flex gap-2"
                                onSubmit={event => {
                                    event.preventDefault();
                                    void addAlias();
                                }}
                            >
                                <input
                                    value={aliasInput}
                                    onChange={event => setAliasInput(event.target.value)}
                                    placeholder={t('series.aliasPlaceholder')}
                                    className="min-w-0 flex-1 rounded-lg border border-line bg-surface/60 px-2.5 py-1.5 text-sm text-fg placeholder:text-zinc-600 focus:border-accent/60 focus:outline-none"
                                />
                                <Button small type="submit" disabled={aliasInput.trim() === ''}>
                                    {t('series.aliasAdd')}
                                </Button>
                            </form>
                            <div className="mt-1.5 text-xs text-zinc-600">{t('series.aliasesHint')}</div>
                        </div>
                        {picker.loading ? (
                            <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
                                <Spinner /> {t('series.changeSourceSearching')}
                            </div>
                        ) : picker.error ? (
                            <div className="mt-4 text-sm text-red-400">{picker.error}</div>
                        ) : (picker.data?.alternatives.length ?? 0) === 0 ? (
                            <div className="mt-4 text-sm text-zinc-500">
                                {t('series.changeSourceEmpty')}
                                {picker.data?.autoAliases && (
                                    <div className="mt-1 text-xs text-zinc-600">
                                        {t('series.changeSourceTriedAliases', { names: picker.data.autoAliases.join(', ') })}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                                {picker.data?.alternatives.map(alternative => (
                                    <div
                                        key={`${alternative.sourceId}:${alternative.mangaId}`}
                                        className="flex items-center gap-3 rounded-lg border border-line bg-zinc-950/50 p-3"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm text-zinc-200">
                                                {alternative.sourceLabel}
                                                {alternative.mangaTitle !== entry.title && (
                                                    <span className="ml-1 text-zinc-500">— {alternative.mangaTitle}</span>
                                                )}
                                            </div>
                                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                                                <span className="text-zinc-300">{t('library.chaptersCount', { n: alternative.chapterCount })}</span>
                                                {alternative.chapterCount > entry.chapterCount && (
                                                    <span className="text-emerald-400">
                                                        {t('series.changeSourceMore', { n: alternative.chapterCount - entry.chapterCount })}
                                                    </span>
                                                )}
                                                <span>{t('series.changeSourceMatch', { n: Math.round((alternative.score ?? 0) * 100) })}</span>
                                            </div>
                                        </div>
                                        <Button small onClick={() => migrateTo(alternative)} loading={migratingTo === alternative.sourceId}>
                                            {t('library.migrate')}
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={missingDialog}
                title={t('series.downloadMissingTitle')}
                body={t('series.downloadMissingBody', { n: missingOnly })}
                danger={false}
                confirmLabel={t('series.downloadAllLabel', { n: missingOnly })}
                secondaryLabel={t('series.downloadNewOnly')}
                onConfirm={() => {
                    setMissingDialog(false);
                    void downloadEverything();
                }}
                onSecondary={() => {
                    setMissingDialog(false);
                    void downloadNewChapters();
                }}
                onCancel={() => setMissingDialog(false)}
            />
        </div>
    );
}
