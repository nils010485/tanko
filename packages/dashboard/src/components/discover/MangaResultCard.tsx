/**
 * Search result card shared by the single-source and the global results.
 */
import type { MangaDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { Cover } from '../Cover.js';
import { IconCheck, IconPlus } from '../icons.js';
import { Button, Card } from '../ui.js';

export function MangaResultCard({
    manga,
    sourceLabel,
    isAdded,
    isAdding,
    followDisabled,
    onChapters,
    onFollow
}: {
    manga: MangaDto;
    sourceLabel: string;
    isAdded: boolean;
    isAdding: boolean;
    followDisabled: boolean;
    onChapters: (manga: MangaDto) => void;
    onFollow: (manga: MangaDto) => void;
}) {
    const { t } = useI18n();
    return (
        <Card className="flex gap-3 p-3">
            <Cover title={manga.title || '?'} thumbnail={manga.thumbnail} className="h-24 w-16 rounded-md" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={manga.title}>
                    {manga.title}
                </div>
                <div className="mt-0.5 truncate text-xs text-faint">{sourceLabel}</div>
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
