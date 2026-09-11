/**
 * Global-search results of the Discover view: progress card, per-source hit
 * groups, a relevance-ranked merged view with cross-source dedup, and the
 * collapsible summary of sources without hits.
 */
import type { GlobalSearchSourceResultDto, GlobalSearchStatusDto, MangaDto, SourceDto } from '@tanko/shared';
import { useMemo, useState } from 'react';
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
    const [mergedView, setMergedView] = useState(false);
    // preferred-language matches first, then out-of-language hits, then the rest
    const globalGroups = useMemo(() => {
        const rank = (group: GlobalSearchSourceResultDto) => (group.outOfLanguages ? 1 : group.status === 'ok' ? (group.mangas.length > 0 ? 0 : 2) : 3);
        return [...globalStatus.results].sort((a, b) => rank(a) - rank(b) || b.mangas.length - a.mangas.length || a.sourceLabel.localeCompare(b.sourceLabel));
    }, [globalStatus]);
    // merged view: cross-source dedup by normalized title, ranked by relevance
    // to the query (exact > starts-with > contains), native sources break ties
    const mergedResults = useMemo(() => {
        const q = globalStatus.query.trim().toLowerCase();
        const score = (title: string) => {
            const normalized = title.toLowerCase();
            if (normalized === q) return 4;
            if (q && normalized.startsWith(q)) return 3;
            if (q && normalized.includes(q)) return 2;
            return 1;
        };
        const instances: { manga: MangaDto; label: string; score: number }[] = [];
        for (const group of globalStatus.results) {
            if (group.status !== 'ok' || group.outOfLanguages) {
                continue;
            }
            for (const manga of group.mangas) {
                instances.push({ manga, label: group.sourceLabel, score: score(manga.title) * 2 + (group.kind === 'native' ? 1 : 0) });
            }
        }
        const byTitle = new Map<string, { manga: MangaDto; score: number; primaryLabel: string; alsoOn: Set<string> }>();
        for (const instance of [...instances].sort((a, b) => b.score - a.score || a.manga.title.localeCompare(b.manga.title))) {
            const key = instance.manga.title.toLowerCase().replace(/[^a-z0-9]+/g, '') || instance.manga.title;
            const existing = byTitle.get(key);
            if (existing) {
                existing.alsoOn.add(instance.label);
            } else {
                byTitle.set(key, { manga: instance.manga, score: instance.score, primaryLabel: instance.label, alsoOn: new Set<string>() });
            }
        }
        return [...byTitle.values()]
            .map(({ alsoOn, primaryLabel, manga, score }) => ({ manga, score, alsoOn: [...alsoOn].filter(label => label !== primaryLabel) }))
            .sort((a, b) => b.score - a.score || a.manga.title.localeCompare(b.manga.title));
    }, [globalStatus]);
    // sources with hits render as cards; the rest (empty/failed/skipped)
    // collapses into a single summary row instead of a wall of empty boxes
    const hitGroups = globalGroups.filter(group => group.mangas.length > 0);
    const missGroups = globalGroups.filter(group => group.mangas.length === 0);
    const missEmptyCount = missGroups.filter(group => group.status === 'ok').length;
    const missFailedCount = missGroups.length - missEmptyCount;
    return (
        <div className="space-y-3">
            <Card className="flex flex-wrap items-center gap-3 p-3 text-sm text-muted">
                {globalSearching ? (
                    <>
                        <Spinner />
                        <span>{t('discover.globalProgress', { done: globalStatus.completed, total: globalStatus.total })}</span>
                    </>
                ) : globalStatus.cancelled ? (
                    <span>{t('discover.globalCancelled')}</span>
                ) : (
                    <span>{t('discover.globalDone', { total: globalStatus.total })}</span>
                )}
                {/* grouped by source (default) or one relevance-ranked merged list */}
                <div className="ml-auto flex h-7 items-center rounded-lg border border-line p-0.5 text-xs">
                    <button
                        type="button"
                        onClick={() => setMergedView(false)}
                        className={`h-full rounded-md px-2.5 transition-colors ${!mergedView ? 'bg-line font-medium text-fg' : 'text-muted hover:text-fg'}`}
                    >
                        {t('discover.viewBySource')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setMergedView(true)}
                        className={`h-full rounded-md px-2.5 transition-colors ${mergedView ? 'bg-line font-medium text-fg' : 'text-muted hover:text-fg'}`}
                    >
                        {t('discover.viewMerged')}
                    </button>
                </div>
                {globalSearching && (
                    <Button small variant="ghost" onClick={onStop}>
                        <IconSquare size={13} /> {t('discover.globalStop')}
                    </Button>
                )}
            </Card>
            {mergedView && mergedResults.length > 0 && (
                <Card className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{t('discover.mergedCount', { n: mergedResults.length })}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {mergedResults.map(({ manga, alsoOn }) => {
                            const key = `${manga.sourceId}:${manga.id}`;
                            const label = globalStatus.results.find(group => group.sourceId === manga.sourceId)?.sourceLabel ?? manga.sourceId;
                            return (
                                <MangaResultCard
                                    key={key}
                                    manga={manga}
                                    sourceLabel={label}
                                    alsoOn={alsoOn}
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
            )}
            {!mergedView &&
                hitGroups.map(group => {
                    const source = sources.find(item => item.id === group.sourceId);
                    return (
                        <Card key={group.sourceId} className="p-4">
                            <div className="flex flex-wrap items-center gap-2">
                                {healthDot(source?.health, t)}
                                <span className="text-sm font-medium">{group.sourceLabel}</span>
                                {group.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                                <span className="text-xs text-faint">
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
                        className="flex w-full items-center gap-2 text-left text-xs text-faint transition-colors hover:text-fg"
                    >
                        <IconChevronDown size={14} className={`flex-none transition-transform ${showMisses ? 'rotate-180' : ''}`} />
                        <span>{t('discover.globalMissSummary', { empty: missEmptyCount, failed: missFailedCount })}</span>
                    </button>
                    {showMisses && (
                        <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                            {missGroups.map(group => (
                                <div key={group.sourceId} className="flex min-w-0 items-center gap-2 text-xs text-faint">
                                    <span className="min-w-0 flex-1 truncate" title={group.error ? `${group.sourceLabel} — ${group.error}` : group.sourceLabel}>
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
            {!globalSearching && globalStatus.completed > 0 && hitGroups.length === 0 && (
                <EmptyState title={t('discover.globalNoResults')} hint={t('discover.globalNoResultsHint')} />
            )}
        </div>
    );
}
