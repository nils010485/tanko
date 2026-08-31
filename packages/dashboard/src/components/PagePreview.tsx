/**
 * Page-preview modal shared by Discover and the series view: shows the pages
 * of one chapter (proxied through the server) with loading / error states.
 */
import { useI18n } from '../i18n/index.js';
import { IconX } from './icons.js';
import { ErrorDetail, Spinner } from './ui.js';

export function PagePreview({
    open,
    title,
    pages,
    loading,
    error,
    sourceId,
    onClose
}: {
    open: boolean;
    title: string;
    pages: string[] | null;
    loading: boolean;
    error: string;
    sourceId: string;
    onClose: () => void;
}) {
    const { t } = useI18n();
    if (!open) {
        return null;
    }
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the parent view handles Escape
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
                    <div className="min-w-0 truncate text-sm font-semibold" title={title}>
                        {t('discover.previewTitle', { title })}
                        {pages && <span className="ml-1 font-normal text-faint">({t('discover.pagesCount', { n: pages.length })})</span>}
                    </div>
                    <button
                        type="button"
                        className="flex-none rounded-md p-1 text-faint hover:bg-line hover:text-fg"
                        onClick={onClose}
                        title={t('common.close')}
                    >
                        <IconX size={16} />
                    </button>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto bg-card/40 p-3">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-10 text-faint">
                            <Spinner /> {t('discover.loadingPages')}
                        </div>
                    ) : error ? (
                        <ErrorDetail error={error} className="py-10 text-center text-sm text-red-400" />
                    ) : (pages || []).length === 0 ? (
                        <div className="py-10 text-center text-sm text-faint">{t('discover.noPages')}</div>
                    ) : (
                        (pages || []).map((url, index) => (
                            <img
                                key={url}
                                src={`/api/sources/${encodeURIComponent(sourceId)}/page-image?url=${encodeURIComponent(url)}`}
                                alt={`page ${index + 1}`}
                                loading="lazy"
                                className="mx-auto w-full max-w-xl rounded-md border border-line"
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
