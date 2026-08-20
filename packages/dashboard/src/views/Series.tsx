/**
 * Series view (Sonarr-style): one page per tracked series — status, follow
 * toggle, check / download actions and the full chapter list with per-chapter
 * download, retry, preview and restore. Reached via #/library/:id.
 */
import type { LibraryChapterDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChapterList, chapterTone } from '../components/ChapterList.js';
import { Cover } from '../components/Cover.js';
import { IconArrowLeft, IconDownload, IconEye, IconLibrary, IconRefresh, IconSearch } from '../components/icons.js';
import { PagePreview } from '../components/PagePreview.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, IconButton, SectionTitle, Spinner, Toggle } from '../components/ui.js';
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
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [preview, setPreview] = useState<PreviewState | null>(null);
    const [selectedChapters, setSelectedChapters] = useState<Set<string>>(new Set());
    const toast = useToast();
    const { t, formatDate } = useI18n();
    /** Ignore responses that resolve after a newer fetch started (series switch, poll, refresh). */
    const requestSeq = useRef(0);
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

    /** Grab the chapters the monitor-only follow left as 'missing'. */
    const downloadMissing = async () => {
        if (!entry) return;
        const missing = toQueueChapters((chapters ?? []).filter(chapter => chapter.status === 'missing'));
        if (missing.length === 0) return;
        setBusyFlag('dlMissing', true);
        try {
            const result = await api.enqueue({ sourceId: entry.sourceId, mangaId: entry.mangaId, mangaTitle: entry.title, chapters: missing });
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

    const missingCount = chapters?.filter(chapter => chapter.status === 'missing').length ?? 0;

    const chapterNode = (chapter: LibraryChapterDto) => (
        <span className="flex flex-none items-center gap-1.5">
            <IconButton title={t('discover.previewHint')} onClick={() => openPreview(chapter)}>
                <IconEye size={14} />
            </IconButton>
            {chapterDownloadable(chapter.status) && (
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
            <Badge tone={chapterTone(chapter.status)}>{t(`library.chapterStatus.${chapter.status}`)}</Badge>
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
                        {!entry.autoDownload && <Badge>{t('library.paused')}</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                        {entry.chapterCount > 0 && <span>{t('library.chaptersRatio', { downloaded: entry.downloadedCount, total: entry.chapterCount })}</span>}
                        {missingCount > 0 && <span className="text-accent-soft">{t('library.missingCount', { n: missingCount })}</span>}
                        {entry.lastCheckedAt && <span className="text-faint">{t('library.seen', { date: formatDate(entry.lastCheckedAt) })}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <Toggle
                            checked={entry.autoDownload}
                            onChange={toggleFollow}
                            label={entry.autoDownload ? t('library.following') : t('library.paused')}
                        />
                        <Button small onClick={checkNow} loading={busy.check}>
                            <IconRefresh size={13} /> {t('library.check')}
                        </Button>
                        <Button small onClick={downloadNewChapters} disabled={entry.newCount === 0} loading={busy.dlNew}>
                            <IconDownload size={13} /> {t('library.downloadNew')}
                        </Button>
                        <Button
                            small
                            variant="ghost"
                            onClick={downloadMissing}
                            disabled={missingCount === 0}
                            loading={busy.dlMissing}
                            title={t('series.downloadMissingHint', { n: missingCount })}
                        >
                            <IconDownload size={13} /> {t('series.downloadMissing')}
                            {missingCount > 0 ? ` (${missingCount})` : ''}
                        </Button>
                        <Button small variant="ghost" onClick={rematch} loading={busy.rematch} title={t('library.rematchHint')}>
                            <IconSearch size={13} /> {t('library.rematch')}
                        </Button>
                    </div>
                </div>
            </Card>

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
            {chapters === null ? (
                <Card className="flex items-center gap-2 p-4 text-sm text-zinc-500">
                    <Spinner /> {t('common.loading')}
                </Card>
            ) : chapters.length === 0 ? (
                <EmptyState title={t('discover.noChapter')} />
            ) : (
                <ChapterList
                    items={chapters.map(chapter => ({ key: String(chapter.id), title: chapter.title, node: chapterNode(chapter) }))}
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
        </div>
    );
}
