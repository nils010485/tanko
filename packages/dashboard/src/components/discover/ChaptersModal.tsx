/**
 * Chapters modal of the Discover view: chapter list of the selected manga
 * with per-chapter preview / ad-hoc download and the follow / download-all
 * footer actions.
 */
import type { ChapterDto, MangaDto } from '@tanko/shared';
import { useMemo } from 'react';
import { useI18n } from '../../i18n/index.js';
import { ChapterList } from '../ChapterList.js';
import { IconCheck, IconDownload, IconEye, IconLibrary, IconPlus, IconX } from '../icons.js';
import { Badge, Button, ErrorDetail, Spinner } from '../ui.js';

export function ChaptersModal({
    selected,
    chapters,
    chaptersError,
    added,
    addingKey,
    onOpenSeries,
    onClose,
    onFollow,
    onPreview,
    onEnqueue
}: {
    selected: MangaDto;
    chapters: ChapterDto[] | null;
    chaptersError: string;
    added: Map<string, number>;
    addingKey: string | null;
    onOpenSeries(id: number): void;
    onClose(): void;
    onFollow(manga: MangaDto): void;
    onPreview(chapter: ChapterDto): void;
    onEnqueue(manga: MangaDto, list: ChapterDto[]): void;
}) {
    const { t } = useI18n();
    const selectedKey = `${selected.sourceId}:${selected.id}`;
    /** Distinct languages among the listed chapters (drives the per-chapter language badge). */
    const chapterLanguages = useMemo(() => new Set((chapters ?? []).map(chapter => chapter.language).filter(Boolean)), [chapters]);
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the modal also closes with Escape (document listener above)
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl shadow-black/60">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0 truncate text-sm font-semibold" title={selected.title}>
                        {selected.title}
                        {chapters && <span className="ml-1 font-normal text-faint">— {t('discover.chaptersCount', { n: chapters.length })}</span>}
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
                        <div className="py-8 text-center text-sm text-faint">
                            {chaptersError ? <ErrorDetail error={chaptersError} /> : t('discover.noChapter')}
                        </div>
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
                            resetKey={selected.id}
                        />
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
                    <Button
                        small
                        onClick={() => onFollow(selected)}
                        disabled={added.has(selectedKey) || addingKey !== null}
                        loading={addingKey === selectedKey}
                    >
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
            </div>
        </div>
    );
}
