/**
 * Duplicate-series dialog of the Discover view: the add hit the library's
 * duplicate-title guard (HTTP 409). Three ways out — link the new provenance
 * to the tracked entry (recommended: one work, one entry, the failover
 * prefers the link), force a separate entry (genuinely different works
 * sharing a title), or cancel.
 */
import type { MangaDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { IconLink, IconPlus } from '../icons.js';
import { Button } from '../ui.js';

export interface DuplicateTarget {
    /** The provenance that hit the guard. */
    manga: MangaDto;
    backlog: 'ignore' | 'grab';
    /** The already-tracked entry it collided with (server's 409 payload). */
    existing: { id: number; title: string; sourceId: string; sourceLabel: string };
}

export function DuplicateDialog({
    target,
    busy,
    onLink,
    onForce,
    onClose
}: {
    target: DuplicateTarget;
    busy: boolean;
    onLink(): void;
    onForce(): void;
    onClose(): void;
}) {
    const { t } = useI18n();
    const { manga, existing } = target;
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener above)
        <div
            className="fixed inset-0 z-[75] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50">
                <div className="text-sm font-semibold text-fg">{t('discover.duplicateTitle', { title: manga.title })}</div>
                <div className="mt-1 text-xs text-muted">{t('discover.duplicateTracked', { source: existing.sourceLabel, title: existing.title })}</div>
                <div className="mt-4 space-y-2">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onLink}
                        className="flex w-full items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 p-3 text-left transition-colors hover:border-accent/60 hover:bg-accent/10 disabled:opacity-50"
                    >
                        <span className="mt-0.5 text-accent-soft">
                            <IconLink size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('discover.duplicateLink')}</span>
                            <span className="mt-0.5 block text-xs text-muted">{t('discover.duplicateLinkHint')}</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onForce}
                        className="flex w-full items-start gap-3 rounded-lg border border-line bg-canvas/60 p-3 text-left transition-colors hover:border-accent/40 hover:bg-card disabled:opacity-50"
                    >
                        <span className="mt-0.5 text-muted">
                            <IconPlus size={16} />
                        </span>
                        <span>
                            <span className="block text-sm font-medium text-fg">{t('discover.duplicateSeparate')}</span>
                            <span className="mt-0.5 block text-xs text-muted">{t('discover.duplicateSeparateHint')}</span>
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
