/**
 * Library removal dialogs: the single-entry chooser (hide vs delete from
 * disk) and its bulk variant for the selection mode. Backdrop click closes;
 * Escape is handled by the Library view's document listener.
 */
import type { LibraryEntryDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { IconEyeOff, IconFolder, IconLibrary } from '../icons.js';
import { Button } from '../ui.js';

/** "Remove <series>?" — hide from Tanko or delete the files from disk. */
export function RemoveEntryDialog({
    entry,
    onHide,
    onAskRemoveFromDisk,
    onClose
}: {
    entry: LibraryEntryDto;
    onHide(): void;
    onAskRemoveFromDisk(): void;
    onClose(): void;
}) {
    const { t } = useI18n();
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener in the view)
        <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('library.removeTitle', { title: entry.title })}
                className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
            >
                <div className="text-sm font-semibold text-fg">{t('library.removeTitle', { title: entry.title })}</div>
                <div className="mt-1 text-xs text-muted">{t('library.removeChoice')}</div>
                <div className="mt-4 space-y-2">
                    <button
                        type="button"
                        onClick={onHide}
                        className="flex w-full items-start gap-3 rounded-lg border border-line bg-canvas/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-card"
                    >
                        <span className="mt-0.5 text-muted">
                            <IconEyeOff size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('library.hideFromTanko')}</span>
                            <span className="mt-0.5 block text-xs text-muted">{t('library.hideFromTankoHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={onAskRemoveFromDisk}
                        className="flex w-full items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-left transition-colors hover:border-red-500/60 hover:bg-red-500/10"
                    >
                        <span className="mt-0.5 text-red-400">
                            <IconFolder size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-red-300">{t('library.deleteFromDisk')}</span>
                            <span className="mt-0.5 block text-xs text-red-300/70">{t('library.deleteFromDiskHint')}</span>
                        </span>
                    </button>
                </div>
                <div className="mt-4 flex justify-end">
                    <Button small variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/** "Remove the N selected series?" — library-only or library + files. */
export function BulkRemoveDialog({ count, onDelete, onClose }: { count: number; onDelete(disk: boolean): void; onClose(): void }) {
    const { t } = useI18n();
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; same pattern as the single-remove dialog above
        <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('library.bulkRemoveTitle', { n: count })}
                className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
            >
                <div className="text-sm font-semibold text-fg">{t('library.bulkRemoveTitle', { n: count })}</div>
                <div className="mt-4 space-y-2">
                    <button
                        type="button"
                        onClick={() => onDelete(false)}
                        className="flex w-full items-start gap-3 rounded-lg border border-line bg-canvas/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-card"
                    >
                        <span className="mt-0.5 text-muted">
                            <IconLibrary size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('library.bulkRemoveOnly')}</span>
                            <span className="mt-0.5 block text-xs text-muted">{t('library.bulkRemoveOnlyHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => onDelete(true)}
                        className="flex w-full items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-left transition-colors hover:border-red-500/60 hover:bg-red-500/10"
                    >
                        <span className="mt-0.5 text-red-400">
                            <IconFolder size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-red-300">{t('library.bulkRemoveDisk')}</span>
                            <span className="mt-0.5 block text-xs text-red-300/70">{t('library.bulkRemoveDiskHint')}</span>
                        </span>
                    </button>
                </div>
                <div className="mt-4 flex justify-end">
                    <Button small variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
