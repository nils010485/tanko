/**
 * Library selection-mode action bar: check / download / pause / resume /
 * hide / rematch / remove for the selected series, plus select-all and exit.
 */
import type { LibraryBulkAction } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { IconDownload, IconEyeOff, IconPause, IconPlay, IconRefresh, IconSearch, IconTrash } from '../icons.js';
import { Button, Card } from '../ui.js';

export function BulkActionBar({
    selectedInView,
    allInViewSelected,
    canSelectAll,
    showHidden,
    bulkBusy,
    onToggleSelectAll,
    onRunBulk,
    onRemoveSelected,
    onExit
}: {
    selectedInView: number;
    allInViewSelected: boolean;
    canSelectAll: boolean;
    showHidden: boolean;
    bulkBusy: string | null;
    onToggleSelectAll(): void;
    onRunBulk(action: LibraryBulkAction): void;
    onRemoveSelected(): void;
    onExit(): void;
}) {
    const { t } = useI18n();
    return (
        <Card className="flex flex-wrap items-center gap-2 p-3">
            <span className="text-sm text-muted">{t('library.selectionCount', { n: selectedInView })}</span>
            <Button small variant="ghost" onClick={onToggleSelectAll} disabled={!canSelectAll}>
                {allInViewSelected ? t('library.deselectAll') : t('library.selectAll')}
            </Button>
            <Button small onClick={() => onRunBulk('check')} disabled={selectedInView === 0} loading={bulkBusy === 'check'}>
                <IconRefresh size={13} /> {t('library.checkSelected', { n: selectedInView })}
            </Button>
            <Button small onClick={() => onRunBulk('downloadNew')} disabled={selectedInView === 0} loading={bulkBusy === 'downloadNew'}>
                <IconDownload size={13} /> {t('library.downloadSelected', { n: selectedInView })}
            </Button>
            <Button small onClick={() => onRunBulk('pause')} disabled={selectedInView === 0} loading={bulkBusy === 'pause'}>
                <IconPause size={13} /> {t('library.pauseSelected')}
            </Button>
            <Button small onClick={() => onRunBulk('resume')} disabled={selectedInView === 0} loading={bulkBusy === 'resume'}>
                <IconPlay size={13} /> {t('library.resumeSelected')}
            </Button>
            <Button small onClick={() => onRunBulk('hide')} disabled={selectedInView === 0} loading={bulkBusy === 'hide'}>
                <IconEyeOff size={13} /> {t('library.hideSelected')}
            </Button>
            {showHidden && (
                <Button small onClick={() => onRunBulk('unhide')} disabled={selectedInView === 0} loading={bulkBusy === 'unhide'}>
                    <IconRefresh size={13} /> {t('library.unhideSelected')}
                </Button>
            )}
            <Button small onClick={() => onRunBulk('rematch')} disabled={selectedInView === 0} loading={bulkBusy === 'rematch'}>
                <IconSearch size={13} /> {t('library.rematch')}
            </Button>
            <Button small variant="danger" onClick={onRemoveSelected} disabled={selectedInView === 0}>
                <IconTrash size={13} /> {t('library.removeSelected', { n: selectedInView })}
            </Button>
            <Button small variant="ghost" onClick={onExit}>
                {t('common.cancel')}
            </Button>
        </Card>
    );
}
