/**
 * Attention banner shown above the library toolbar while migration
 * suggestions are pending. One line, one CTA; "Later" hides it for the
 * rest of the session (the suggestions themselves stay pending).
 */
import { useI18n } from '../i18n/index.js';
import { IconArrowLeftRight } from './icons.js';
import { Button } from './ui.js';

export function MigrationBanner({ count, onReview, onLater }: { count: number; onReview: () => void; onLater: () => void }) {
    const { t } = useI18n();
    return (
        <div className="flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3">
            <IconArrowLeftRight size={16} className="flex-none text-accent-soft" />
            <p className="min-w-0 flex-1 text-sm">
                <span className="font-semibold text-accent-soft">{t('library.migrationBanner', { n: count })}</span>
                <span className="hidden text-muted sm:inline"> — {t('library.migrationBannerHint')}</span>
            </p>
            <button type="button" onClick={onLater} className="flex-none text-xs font-semibold text-muted transition-colors hover:text-fg">
                {t('library.migrationLater')}
            </button>
            <Button small onClick={onReview}>
                {t('library.migrationReview')}
            </Button>
        </div>
    );
}
