/**
 * Chapters modal of the Discover view: chapter list of the selected manga
 * with per-chapter preview / ad-hoc download and the follow / download-all
 * footer actions.
 */
import type { ChapterDto, MangaDto, SourceDto } from '@tanko/shared';
import { useMemo } from 'react';
import { useI18n } from '../../i18n/index.js';
import { ChapterList } from '../ChapterList.js';
import { IconCheck, IconDownload, IconEye, IconLibrary, IconPlus, IconX } from '../icons.js';
import { Badge, Button, ErrorDetail, Modal, Select, Spinner } from '../ui.js';

export function ChaptersModal({
    selected,
    instances,
    sources,
    chapters,
    chaptersError,
    added,
    addingKey,
    onOpenSeries,
    onClose,
    onFollow,
    onChaptersOf,
    onPreview,
    onEnqueue
}: {
    selected: MangaDto;
    instances: MangaDto[];
    sources: SourceDto[];
    chapters: ChapterDto[] | null;
    chaptersError: string;
    added: Map<string, number>;
    addingKey: string | null;
    onOpenSeries(id: number): void;
    onClose(): void;
    onFollow(manga: MangaDto): void;
    onChaptersOf(manga: MangaDto): void;
    onPreview(chapter: ChapterDto): void;
    onEnqueue(manga: MangaDto, list: ChapterDto[]): void;
}) {
    const { t } = useI18n();
    const selectedKey = `${selected.sourceId}:${selected.id}`;
    const labelOf = (sourceId: string) => sources.find(source => source.id === sourceId)?.label ?? sourceId;
    const sourceLabel = labelOf(selected.sourceId);
    /** Distinct languages among the listed chapters (drives the per-chapter language badge). */
    const chapterLanguages = useMemo(() => new Set((chapters ?? []).map(chapter => chapter.language).filter(Boolean)), [chapters]);
    const emptyState = chaptersError ? (
        <ErrorDetail error={chaptersError} />
    ) : (
        <>
            <div>{t('discover.noChapter')}</div>
            <div className="mx-auto mt-1.5 max-w-sm text-xs">{t('discover.noChapterHint', { source: sourceLabel })}</div>
        </>
    );
    return (
        <Modal
            overlayClassName="z-50 bg-black/70"
            panelClassName="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl shadow-black/60"
            onClose={onClose}
        >
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" title={selected.title}>
                        {selected.title}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                        {instances.length > 1 ? (
                            <Select
                                className="w-auto py-1 text-xs"
                                value={selected.sourceId}
                                onChange={sourceId => {
                                    const next = instances.find(instance => instance.sourceId === sourceId);
                                    if (next) onChaptersOf(next);
                                }}
                                options={instances.map(instance => ({ value: instance.sourceId, label: labelOf(instance.sourceId) }))}
                            />
                        ) : (
                            <span className="truncate">{sourceLabel}</span>
                        )}
                        {chapters && <span>- {t('discover.chaptersCount', { n: chapters.length })}</span>}
                    </div>
                </div>
                <button
                    type="button"
                    className="flex-none rounded-md p-1 text-faint transition-colors hover:bg-line hover:text-fg"
                    onClick={onClose}
                    title={t('common.close')}
                >
                    <IconX size={16} />
                </button>
            </div>

            <div className="flex-1 space-y-1 overflow-y-auto p-3 text-sm">
                {!chapters ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-faint">
                        <Spinner /> {t('common.loading')}
                    </div>
                ) : chapters.length === 0 ? (
                    <div className="py-8 text-center text-sm text-faint">{emptyState}</div>
                ) : (
                    <ChapterList
                        items={chapters.map(chapter => ({
                            key: chapter.id,
                            title: chapter.title,
                            badge: chapterLanguages.size > 1 && chapter.language ? <Badge>{chapter.language}</Badge> : undefined,
                            node: (
                                <div className="flex flex-none items-center gap-1">
                                    <Button small variant="ghost" title={t('discover.previewHint')} onClick={() => onPreview(chapter)}>
                                        <IconEye size={14} />
                                    </Button>
                                    <Button small variant="ghost" onClick={() => onEnqueue(selected, [chapter])}>
                                        <span className="flex items-center gap-1">
                                            <IconDownload size={12} /> DL
                                        </span>
                                    </Button>
                                </div>
                            )
                        }))}
                        resetKey={selectedKey}
                    />
                )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
                <Button small onClick={() => onFollow(selected)} disabled={added.has(selectedKey) || addingKey !== null} loading={addingKey === selectedKey}>
                    {added.has(selectedKey) ? <IconCheck size={13} /> : <IconPlus size={13} />}
                    {added.has(selectedKey) ? t('discover.inLibrary') : t('discover.followSeries')}
                </Button>
                <Button small variant="ghost" onClick={() => onEnqueue(selected, chapters ?? [])} disabled={(chapters ?? []).length === 0}>
                    <IconDownload size={13} /> {t('discover.downloadAll')}
                    {(chapters ?? []).length > 0 ? ` (${chapters?.length})` : ''}
                </Button>
                {added.has(selectedKey) && (
                    <Button small variant="ghost" onClick={() => onOpenSeries(added.get(selectedKey) ?? 0)}>
                        <IconLibrary size={13} /> {t('discover.openSeries')}
                    </Button>
                )}
            </div>
        </Modal>
    );
}
