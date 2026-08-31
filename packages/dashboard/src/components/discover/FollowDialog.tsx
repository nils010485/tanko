/**
 * Follow dialog of the Discover view: monitor-only vs grab-the-backlog
 * choice for adding a manga to the library.
 */
import type { MangaDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { IconBookmark, IconDownload } from '../icons.js';
import { Button } from '../ui.js';

export function FollowDialog({
    followTarget,
    followCount,
    addingKey,
    onFollow,
    onClose
}: {
    followTarget: MangaDto;
    followCount: number | null;
    addingKey: string | null;
    onFollow(manga: MangaDto, backlog: 'ignore' | 'grab'): void;
    onClose(): void;
}) {
    const { t } = useI18n();
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener above)
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50">
                <div className="text-sm font-semibold text-fg">{t('discover.followChoiceTitle', { title: followTarget.title })}</div>
                <div className="mt-4 space-y-2">
                    <button
                        type="button"
                        disabled={addingKey !== null}
                        onClick={() => onFollow(followTarget, 'ignore')}
                        className="flex w-full items-start gap-3 rounded-lg border border-line bg-canvas/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-card disabled:opacity-50"
                    >
                        <span className="mt-0.5 text-muted">
                            <IconBookmark size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('discover.followMonitor')}</span>
                            <span className="mt-0.5 block text-xs text-muted">{t('discover.followMonitorHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        disabled={addingKey !== null}
                        onClick={() => onFollow(followTarget, 'grab')}
                        className="flex w-full items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-left transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:opacity-50"
                    >
                        <span className="mt-0.5 text-accent-soft">
                            <IconDownload size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('discover.followGrab')}</span>
                            <span className="mt-0.5 block text-xs text-muted">
                                {followCount !== null ? t('discover.followGrabHint', { n: followCount }) : t('discover.followGrabHintUnknown')}
                            </span>
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
