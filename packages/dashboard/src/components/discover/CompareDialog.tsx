import type { MangaDto, SourceDto } from '@tanko/shared';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import { api } from '../../lib/api.js';
import { Cover } from '../Cover.js';
import { IconCheck, IconPlus, IconX } from '../icons.js';
import { Badge, Button, Modal, Spinner } from '../ui.js';
import { healthDot } from './SourcePicker.js';

type SourceStats = { count: number; langs: string[] } | { error: string };

function countOf(stats: Map<string, SourceStats>, sourceId: string): number {
    const stat = stats.get(sourceId);
    return stat && 'count' in stat ? stat.count : -1;
}

export function CompareDialog({
    instances,
    sources,
    added,
    addingKey,
    onClose,
    onFollow,
    onChapters
}: {
    instances: MangaDto[];
    sources: SourceDto[];
    added: Map<string, number>;
    addingKey: string | null;
    onClose(): void;
    onFollow(manga: MangaDto): void;
    onChapters(manga: MangaDto, instances: MangaDto[]): void;
}) {
    const { t } = useI18n();
    const [stats, setStats] = useState<Map<string, SourceStats>>(new Map());
    useEffect(() => {
        let alive = true;
        for (const manga of instances) {
            api.chapters(manga.sourceId, manga.id, manga.title)
                .then(list => {
                    if (!alive) return;
                    const langs = [...new Set(list.map(chapter => chapter.language).filter((lang): lang is string => Boolean(lang)))];
                    setStats(current => new Map(current).set(manga.sourceId, { count: list.length, langs }));
                })
                .catch((error: unknown) => {
                    if (!alive) return;
                    setStats(current => new Map(current).set(manga.sourceId, { error: String((error as Error)?.message || error) }));
                });
        }
        return () => {
            alive = false;
        };
    }, [instances]);

    const rows = useMemo(() => {
        if (!instances.every(manga => stats.has(manga.sourceId))) return instances;
        return [...instances].sort((a, b) => countOf(stats, b.sourceId) - countOf(stats, a.sourceId) || a.sourceId.localeCompare(b.sourceId));
    }, [instances, stats]);
    const maxCount = Math.max(...rows.map(row => countOf(stats, row.sourceId)));
    const head = instances[0];

    return (
        <Modal
            overlayClassName="z-[60] bg-black/70"
            panelClassName="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl shadow-black/60"
            onClose={onClose}
            ariaLabel={t('discover.compareTitle')}
        >
            <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                <Cover title={head.title || '?'} thumbnail={head.thumbnail} sourceId={head.sourceId} className="h-16 w-11 flex-none rounded-md" />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold" title={head.title}>
                        {head.title}
                    </div>
                    <div className="mt-0.5 text-xs text-faint">{t('discover.compareSubtitle', { n: instances.length })}</div>
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

            <div className="flex-1 space-y-2 overflow-y-auto p-3">
                <p className="px-1 text-xs text-muted">{t('discover.compareLead')}</p>
                {rows.map(manga => {
                    const source = sources.find(item => item.id === manga.sourceId);
                    const stat = stats.get(manga.sourceId);
                    const key = `${manga.sourceId}:${manga.id}`;
                    const isAdded = added.has(key);
                    const isBest = stat && 'count' in stat && stat.count === maxCount && maxCount > 0;

                    let detail: ReactNode;
                    if (!stat) {
                        detail = (
                            <span className="inline-flex items-center gap-1.5">
                                <Spinner size={12} /> {t('common.loading')}
                            </span>
                        );
                    } else if ('error' in stat) {
                        detail = <span className="text-red-400">{stat.error}</span>;
                    } else {
                        detail = (
                            <>
                                <span className="font-medium text-fg">{t('discover.chaptersCount', { n: stat.count })}</span>
                                {stat.langs.map(lang => (
                                    <Badge key={lang} tone="blue">
                                        {lang.toUpperCase()}
                                    </Badge>
                                ))}
                            </>
                        );
                    }

                    return (
                        <div
                            key={manga.sourceId}
                            className={`rounded-lg border p-3 ${isBest ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-line bg-surface'}`}
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                {healthDot(source?.health, t)}
                                <span className="text-sm font-medium">{source?.label ?? manga.sourceId}</span>
                                {source?.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                                {isBest && <Badge tone="green">{t('discover.compareBest')}</Badge>}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-faint">{detail}</div>
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                                <Button small variant="ghost" onClick={() => onChapters(manga, instances)}>
                                    {t('discover.chapters')}
                                </Button>
                                <Button small disabled={isAdded || addingKey !== null} loading={addingKey === key} onClick={() => onFollow(manga)}>
                                    {isAdded ? <IconCheck size={13} /> : <IconPlus size={13} />}
                                    {isAdded ? t('discover.followed') : t('discover.followFrom')}
                                </Button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Modal>
    );
}
