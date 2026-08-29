/**
 * Global-search results of the Discover view: progress card, per-source hit
 * groups and the collapsible summary of sources without hits.
 */
import type { GlobalSearchSourceResultDto, GlobalSearchStatusDto, MangaDto, SourceDto } from '@tanko/shared';
import { useMemo } from 'react';
import type { TFunction } from '../../i18n/index.js';
import { useI18n } from '../../i18n/index.js';
import { IconChevronDown, IconGlobe, IconSquare } from '../icons.js';
import { Badge, Button, Card, EmptyState, Spinner } from '../ui.js';
import { MangaResultCard } from './MangaResultCard.js';
import { healthDot } from './SourcePicker.js';

/** i18n key for each failed global-search status ('ok' groups show counts instead). */
const GLOBAL_STATUS_KEYS: Record<'error' | 'timeout' | 'skipped', Parameters<TFunction>[0]> = {
    error: 'discover.globalSourceError',
    timeout: 'discover.globalSourceTimeout',
    skipped: 'discover.globalSourceSkipped'
};

export function GlobalResults({
    globalStatus,
    globalSearching,
    sources,
    added,
    addingKey,
    showMisses,
    onToggleMisses,
    onStop,
    onChapters,
    onFollow
}: {
    globalStatus: GlobalSearchStatusDto;
    globalSearching: boolean;
    sources: SourceDto[];
    added: Map<string, number>;
    addingKey: string | null;
    showMisses: boolean;
    onToggleMisses(): void;
    onStop(): void;
    onChapters(manga: MangaDto): void;
    onFollow(manga: MangaDto): void;
}) {
    const { t } = useI18n();
    // preferred-language matches first, then out-of-language hits, then the rest
    const globalGroups = useMemo(() => {
        // preferred-language matches first, then out-of-language hits, then the rest
        const rank = (group: GlobalSearchSourceResultDto) => (group.outOfLanguages ? 1 : group.status === 'ok' ? (group.mangas.length > 0 ? 0 : 2) : 3);
        return [...globalStatus.results].sort((a, b) => rank(a) - rank(b) || b.mangas.length - a.mangas.length || a.sourceLabel.localeCompare(b.sourceLabel));
    }, [globalStatus]);
    // sources with hits render as cards; the rest (empty/failed/skipped)
    // collapses into a single summary row instead of a wall of empty boxes
    const hitGroups = globalGroups.filter(group => group.mangas.length > 0);
    const missGroups = globalGroups.filter(group => group.mangas.length === 0);
    const missEmptyCount = missGroups.filter(group => group.status === 'ok').length;
    const missFailedCount = missGroups.length - missEmptyCount;
    return (
        <div className="space-y-3">
            <Card className="flex flex-wrap items-center gap-3 p-3 text-sm text-zinc-400">
                {globalSearching ? (
                    <>
                        <Spinner />
                        <span>{t('discover.globalProgress', { done: globalStatus.completed, total: globalStatus.total })}</span>
                        <span className="ml-auto">
                            <Button small variant="ghost" onClick={onStop}>
                                <IconSquare size={13} /> {t('discover.globalStop')}
                            </Button>
                        </span>
                    </>
                ) : (
                    <span>{t('discover.globalDone', { total: globalStatus.total })}</span>
                )}
            </Card>
            {hitGroups.map(group => {
                const source = sources.find(item => item.id === group.sourceId);
                return (
                    <Card key={group.sourceId} className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            {healthDot(source?.health, t)}
                            <span className="text-sm font-medium">{group.sourceLabel}</span>
                            {group.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                            <span className="text-xs text-zinc-500">
                                {t('discover.globalResultsCount', { n: group.mangas.length })}
                                {group.tookMs !== undefined ? ` · ${group.tookMs} ms` : ''}
                            </span>
                            {group.outOfLanguages && (
                                <Badge tone="orange">
                                    <IconGlobe size={12} /> {t('discover.outOfLanguages')}
                                </Badge>
                            )}
                        </div>
                        <div className={`mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3${group.outOfLanguages ? ' opacity-60' : ''}`}>
                            {group.mangas.map(manga => {
                                const key = `${manga.sourceId}:${manga.id}`;
                                return (
                                    <MangaResultCard
                                        key={key}
                                        manga={manga}
                                        sourceLabel={group.sourceLabel}
                                        isAdded={added.has(key)}
                                        isAdding={addingKey === key}
                                        followDisabled={addingKey !== null}
                                        onChapters={onChapters}
                                        onFollow={onFollow}
                                    />
                                );
                            })}
                        </div>
                    </Card>
                );
            })}
            {missGroups.length > 0 && (
                <Card className="p-3">
                    <button
                        type="button"
                        onClick={onToggleMisses}
                        className="flex w-full items-center gap-2 text-left text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                        <IconChevronDown size={14} className={`flex-none transition-transform ${showMisses ? 'rotate-180' : ''}`} />
                        <span>{t('discover.globalMissSummary', { empty: missEmptyCount, failed: missFailedCount })}</span>
                    </button>
                    {showMisses && (
                        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                            {missGroups.map(group => (
                                <div key={group.sourceId} className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                                    <span className="min-w-0 flex-1 truncate" title={group.error ? `${group.sourceLabel} — ${group.error}` : group.sourceLabel}>
                                        {group.sourceLabel}
                                    </span>
                                    {group.status === 'ok' ? (
                                        <span className="flex-none text-zinc-600">{t('discover.noResults')}</span>
                                    ) : (
                                        <Badge tone={group.status === 'skipped' ? undefined : 'red'}>{t(GLOBAL_STATUS_KEYS[group.status])}</Badge>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            )}
            {!globalSearching && globalStatus.completed > 0 && hitGroups.length === 0 && (
                <EmptyState title={t('discover.globalNoResults')} hint={t('discover.globalNoResultsHint')} />
            )}
        </div>
    );
}
