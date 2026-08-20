/**
 * Accessible confirmation modal — replaces window.confirm().
 * Closes on Escape and on backdrop click.
 */
import { type ReactNode, useEffect } from 'react';
import { useI18n } from '../i18n/index.js';
import { Button } from './ui.js';

export function ConfirmDialog({
    open,
    title,
    body,
    confirmLabel,
    danger = true,
    onConfirm,
    onCancel
}: {
    open: boolean;
    title: string;
    body?: ReactNode;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const { t } = useI18n();
    const resolvedConfirmLabel = confirmLabel ?? t('confirm.confirm');
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onCancel();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onCancel]);

    if (!open) return null;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (document listener above)
        <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) onCancel();
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="w-full max-w-sm rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
            >
                <div className="break-words text-sm font-semibold text-fg">{title}</div>
                {body && <div className="mt-2 break-words text-sm text-muted">{body}</div>}
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <Button small variant="ghost" onClick={onCancel}>
                        {t('common.cancel')}
                    </Button>
                    <Button small variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
                        {resolvedConfirmLabel}
                    </Button>
                </div>
            </div>
        </div>
    );
}
