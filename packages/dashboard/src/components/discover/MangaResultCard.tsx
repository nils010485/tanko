/**
 * Search result card shared by the single-source and the global results.
 */
import type { MangaDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { Cover } from '../Cover.js';
import { IconCheck, IconPlus } from '../icons.js';
import { Badge, Button, Card } from '../ui.js';

export function MangaResultCard({
    manga,
    sourceLabel,
    alsoOn,
    sourceCount,
    isAdded,
    isAdding,
    followDisabled,
    onChapters,
    onFollow,
    onCompare
}: {
    manga: MangaDto;
    sourceLabel: string;
    /** Other sources carrying the same title (merged global view). */
    alsoOn?: string[];
    sourceCount?: number;
    isAdded: boolean;
    isAdding: boolean;
    followDisabled: boolean;
    onChapters: (manga: MangaDto) => void;
    onFollow: (manga: MangaDto) => void;
    onCompare?: () => void;
}) {
    const { t } = useI18n();
    return (
        <Card className="flex gap-3 p-3">
            <Cover title={manga.title || '?'} thumbnail={manga.thumbnail} sourceId={manga.sourceId} className="h-24 w-16 rounded-md" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={manga.title}>
                    {manga.title}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
                    <span className="truncate">{sourceLabel}</span>
                    {sourceCount !== undefined && sourceCount > 1 && (
                        <span className="ml-auto flex-none">
                            <Badge tone="orange">{t('discover.sourceCount', { n: sourceCount })}</Badge>
                        </span>
                    )}
                </div>
                {alsoOn && alsoOn.length > 0 ? (
                    <div className="mt-0.5 truncate text-[11px] text-faint/80" title={alsoOn.join(', ')}>
                        {t('discover.alsoOn', { sources: alsoOn.join(', ') })}
                        {onCompare && (
                            <>
                                {' · '}
                                <button type="button" onClick={onCompare} className="font-medium text-accent-soft underline-offset-2 hover:underline">
                                    {t('discover.compare')}
                                </button>
                            </>
                        )}
                    </div>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button small variant="ghost" onClick={() => onChapters(manga)}>
                        {t('discover.chapters')}
                    </Button>
                    <Button small disabled={isAdded || followDisabled} loading={isAdding} onClick={() => onFollow(manga)}>
                        {isAdded ? <IconCheck size={13} /> : <IconPlus size={13} />}
                        {isAdded ? t('discover.followed') : t('discover.follow')}
                    </Button>
                </div>
            </div>
        </Card>
    );
}
