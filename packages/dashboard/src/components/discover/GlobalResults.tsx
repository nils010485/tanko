import type { GlobalSearchStatusDto, MangaDto } from '@tanko/shared';
import { type ReactNode, useMemo, useState } from 'react';
import type { TFunction } from '../../i18n/index.js';
import { useI18n } from '../../i18n/index.js';
import { IconChevronDown, IconSquare } from '../icons.js';
import { Badge, Button, Card, EmptyState, ProgressBar, Select, Skeleton, Spinner } from '../ui.js';
import { MangaResultCard } from './MangaResultCard.js';

/** i18n key for each failed global-search status ('ok' groups show counts instead). */
const GLOBAL_STATUS_KEYS: Record<'error' | 'timeout' | 'skipped', Parameters<TFunction>[0]> = {
    error: 'discover.globalSourceError',
    timeout: 'discover.globalSourceTimeout',
    skipped: 'discover.globalSourceSkipped'
};

function fold(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

export function GlobalResults({
    globalStatus,
    globalSearching,
    added,
    addingKey,
    showMisses,
    onToggleMisses,
    onStop,
    onChapters,
    onFollow,
    onCompare
}: {
    globalStatus: GlobalSearchStatusDto;
    globalSearching: boolean;
    added: Map<string, number>;
    addingKey: string | null;
    showMisses: boolean;
    onToggleMisses(): void;
    onStop(): void;
    onChapters(manga: MangaDto): void;
    onFollow(manga: MangaDto): void;
    onCompare(instances: MangaDto[]): void;
}) {
    const { t } = useI18n();
    const [sort, setSort] = useState<'rel' | 'title' | 'sources'>('rel');

    const merged = useMemo(() => {
        const labelOf = new Map(globalStatus.results.map(group => [group.sourceId, group.sourceLabel]));
        const q = fold(globalStatus.query.trim());
        const score = (title: string) => {
            const normalized = fold(title);
            if (normalized === q) return 4;
            if (q && normalized.startsWith(q)) return 3;
            if (q && normalized.includes(q)) return 2;
            return 1;
        };
        const byKey = new Map<string, { manga: MangaDto; score: number; firstOrder: number; instances: MangaDto[]; labels: Set<string> }>();
        let order = 0;
        for (const group of globalStatus.results) {
            if (group.status !== 'ok' || group.outOfLanguages) {
                continue;
            }
            for (const manga of group.mangas) {
                const rank = score(manga.title) * 2 + (group.kind === 'native' ? 1 : 0);
                const key = fold(manga.title).replace(/[^a-z0-9]+/g, '') || manga.title;
                const label = labelOf.get(manga.sourceId) ?? manga.sourceId;
                const existing = byKey.get(key);
                if (existing) {
                    existing.instances.push(manga);
                    existing.labels.add(label);
                    if (rank > existing.score) {
                        existing.manga = manga;
                        existing.score = rank;
                    }
                } else {
                    byKey.set(key, { manga, score: rank, firstOrder: order, instances: [manga], labels: new Set([label]) });
                }
                order++;
            }
        }
        return [...byKey.values()]
            .sort((a, b) => b.score - a.score || a.firstOrder - b.firstOrder)
            .map(entry => {
                const primaryLabel = labelOf.get(entry.manga.sourceId) ?? entry.manga.sourceId;
                return {
                    manga: entry.manga,
                    instances: entry.instances,
                    sourceLabel: primaryLabel,
                    alsoOn: [...entry.labels].filter(label => label !== primaryLabel)
                };
            });
    }, [globalStatus]);

    const ordered = useMemo(() => {
        if (sort === 'title') return [...merged].sort((a, b) => a.manga.title.localeCompare(b.manga.title));
        if (sort === 'sources') return [...merged].sort((a, b) => b.instances.length - a.instances.length || a.manga.title.localeCompare(b.manga.title));
        return merged;
    }, [merged, sort]);

    const missGroups = globalStatus.results.filter(group => group.mangas.length === 0);
    const missEmptyCount = missGroups.filter(group => group.status === 'ok').length;
    const missFailedCount = missGroups.length - missEmptyCount;
    const failedCount = globalStatus.results.filter(group => group.status !== 'ok').length;
    const percent = globalStatus.total > 0 ? (globalStatus.completed / globalStatus.total) * 100 : 100;

    let statusSummary: ReactNode;
    if (globalSearching) {
        statusSummary = t('discover.globalProgress', { done: globalStatus.completed, total: globalStatus.total });
    } else if (globalStatus.cancelled) {
        statusSummary = t('discover.globalCancelled');
    } else {
        statusSummary = (
            <>
                {t('discover.globalDone', { total: globalStatus.total })}
                {failedCount > 0 && <span className="text-amber-400"> · {t('discover.globalDoneFail', { n: failedCount })}</span>}
            </>
        );
    }

    return (
        <div className="space-y-3">
            <Card className="flex items-center gap-3 px-3 py-2 text-muted">
                {globalSearching && <Spinner size={14} />}
                <span className="whitespace-nowrap text-xs">{statusSummary}</span>
                <div className="min-w-10 flex-1">
                    <ProgressBar value={percent} />
                </div>
                {globalSearching && (
                    <Button small variant="ghost" onClick={onStop}>
                        <IconSquare size={13} /> {t('discover.globalStop')}
                    </Button>
                )}
            </Card>

            <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-faint">
                <span className="text-sm font-medium text-fg">{t('discover.mergedCount', { n: merged.length })}</span>
                {globalSearching && <span>· {t('discover.globalLive')}</span>}
                {merged.length > 1 && (
                    <Select
                        className="ml-auto w-auto py-1 text-xs"
                        value={sort}
                        onChange={value => setSort(value as 'rel' | 'title' | 'sources')}
                        options={[
                            { value: 'rel', label: t('discover.sortRelevance') },
                            { value: 'title', label: t('discover.sortTitle') },
                            { value: 'sources', label: t('discover.sortSources') }
                        ]}
                    />
                )}
            </div>

            {merged.length > 0 && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {ordered.map(entry => {
                        const key = `${entry.manga.sourceId}:${entry.manga.id}`;
                        return (
                            <MangaResultCard
                                key={key}
                                manga={entry.manga}
                                sourceLabel={entry.sourceLabel}
                                alsoOn={entry.alsoOn}
                                sourceCount={entry.instances.length}
                                isAdded={added.has(key)}
                                isAdding={addingKey === key}
                                followDisabled={addingKey !== null}
                                onChapters={onChapters}
                                onFollow={onFollow}
                                onCompare={() => onCompare(entry.instances)}
                            />
                        );
                    })}
                </div>
            )}
            {merged.length === 0 && globalSearching && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {[0, 1, 2].map(index => (
                        <Card key={index} className="flex gap-3 p-3">
                            <Skeleton className="h-24 w-16 flex-none rounded-md" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-4 w-3/4" />
                                <Skeleton className="h-3 w-1/2" />
                                <Skeleton className="mt-3 h-7 w-2/3" />
                            </div>
                        </Card>
                    ))}
                </div>
            )}

            {missGroups.length > 0 && (
                <Card className="p-3">
                    <button
                        type="button"
                        onClick={onToggleMisses}
                        className="flex w-full items-center gap-2 text-left text-xs text-faint transition-colors hover:text-fg"
                    >
                        <IconChevronDown size={14} className={`flex-none transition-transform ${showMisses ? 'rotate-180' : ''}`} />
                        <span>{t('discover.globalMissSummary', { empty: missEmptyCount, failed: missFailedCount })}</span>
                    </button>
                    {showMisses && (
                        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                            {missGroups.map(group => (
                                <div key={group.sourceId} className="flex min-w-0 items-center gap-2 text-xs text-faint">
                                    <span className="min-w-0 flex-1 truncate" title={group.error ? `${group.sourceLabel} - ${group.error}` : group.sourceLabel}>
                                        {group.sourceLabel}
                                    </span>
                                    {group.status === 'ok' ? (
                                        <span className="flex-none text-faint">{t('discover.noResults')}</span>
                                    ) : (
                                        <Badge tone={group.status === 'skipped' ? undefined : 'red'}>{t(GLOBAL_STATUS_KEYS[group.status])}</Badge>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            )}
            {!globalSearching && globalStatus.completed > 0 && merged.length === 0 && (
                <EmptyState title={t('discover.globalNoResults')} hint={t('discover.globalNoResultsHint')} />
            )}
        </div>
    );
}
