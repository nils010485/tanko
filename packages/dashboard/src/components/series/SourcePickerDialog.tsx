/**
 * Manual source picker dialog (Series view): linked provenances, the crawled
 * alternatives with their match scores, and the alias editor the failover
 * relies on. Pure presentation — state and actions stay in the view.
 */
import type { LibraryAlternativeDto, LibraryEntryDto, SourceAlternativeDto, SourceAlternativesResponseDto } from '@tanko/shared';
import { useI18n } from '../../i18n/index.js';
import { IconX } from '../icons.js';
import { Button, IconButton, Spinner } from '../ui.js';

interface SourcePickerDialogProps {
    entry: LibraryEntryDto;
    picker: { open: boolean; loading: boolean; error: string; data: SourceAlternativesResponseDto | null };
    /** Linked provenances of the same work (null = not loaded yet). */
    linked: LibraryAlternativeDto[] | null;
    migratingTo: string | null;
    unlinking: number | null;
    aliasInput: string;
    onAliasInput: (value: string) => void;
    aliasFetchBusy: boolean;
    onClose: () => void;
    onMigrate: (target: SourceAlternativeDto) => void;
    onUnlink: (alternativeId: number) => void;
    onSaveAliases: (aliases: string[]) => void;
    onAddAlias: () => void;
    onFetchAliases: () => void;
}

export function SourcePickerDialog({
    entry,
    picker,
    linked,
    migratingTo,
    unlinking,
    aliasInput,
    onAliasInput,
    aliasFetchBusy,
    onClose,
    onMigrate,
    onUnlink,
    onSaveAliases,
    onAddAlias,
    onFetchAliases
}: SourcePickerDialogProps) {
    const { t } = useI18n();
    // local names mirror the view's callbacks so the extracted JSX stays verbatim
    const closePicker = onClose;
    const migrateTo = onMigrate;
    const unlink = onUnlink;
    const saveAliases = onSaveAliases;
    const addAlias = onAddAlias;
    const fetchAliasesFromAniList = onFetchAliases;
    const busy = { aliasFetch: aliasFetchBusy };
    const setAliasInput = onAliasInput;
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (useEscapeKey in the view)
        <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) closePicker();
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('series.changeSource')}
                className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl shadow-black/50"
            >
                <div className="flex items-center justify-between gap-2">
                    <div className="break-words text-sm font-semibold text-fg">{t('series.changeSource')}</div>
                    <IconButton title={t('common.close')} onClick={closePicker}>
                        <IconX size={14} />
                    </IconButton>
                </div>
                <div className="mt-1 text-xs text-faint">
                    {entry.sourceLabel} · {t('library.chaptersCount', { n: entry.chapterCount })} ({t('series.changeSourceCurrent')})
                </div>

                {/* linked provenances: recorded alternatives of the same work */}
                <div className="mt-3 rounded-lg border border-line bg-canvas/50 p-3">
                    <div className="break-words text-sm font-semibold text-fg">{t('series.linkedTitle')}</div>
                    <div className="mt-0.5 text-xs text-faint">{t('series.linkedHint')}</div>
                    {linked === null ? (
                        <div className="mt-2 text-xs text-faint">…</div>
                    ) : linked.length === 0 ? (
                        <div className="mt-2 text-xs text-faint">{t('series.linkedEmpty')}</div>
                    ) : (
                        <div className="mt-2 space-y-2">
                            {linked.map(alternative => (
                                <div key={alternative.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface/60 p-2.5">
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm text-fg">
                                            {alternative.sourceLabel}
                                            {alternative.title !== entry.title && <span className="ml-1 text-faint">— {alternative.title}</span>}
                                        </div>
                                    </div>
                                    <Button
                                        small
                                        onClick={() =>
                                            void migrateTo({
                                                sourceId: alternative.sourceId,
                                                sourceLabel: alternative.sourceLabel,
                                                mangaId: alternative.mangaId,
                                                mangaTitle: alternative.title,
                                                chapterCount: alternative.chapterCount ?? entry.chapterCount,
                                                score: alternative.score ?? 1
                                            })
                                        }
                                        loading={migratingTo === alternative.sourceId}
                                    >
                                        {t('series.linkedMigrate')}
                                    </Button>
                                    <IconButton
                                        title={t('series.linkedRemove')}
                                        onClick={() => void unlink(alternative.id)}
                                        disabled={unlinking === alternative.id}
                                    >
                                        <IconX size={14} />
                                    </IconButton>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* alias editor: the other names the failover searches too (AniList or manual) */}
                <div className="mt-3 rounded-lg border border-line bg-canvas/50 p-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-faint">{t('series.aliases')}:</span>
                        {[...new Set(entry.aliases ?? [])].map(alias => (
                            <button
                                key={alias}
                                type="button"
                                onClick={() => void saveAliases((entry.aliases ?? []).filter(item => item !== alias))}
                                title={t('series.aliasRemoveHint')}
                                className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-fg transition-colors hover:border-red-500/50 hover:text-red-400"
                            >
                                {alias} <IconX size={10} />
                            </button>
                        ))}
                        <Button small variant="ghost" onClick={fetchAliasesFromAniList} loading={busy.aliasFetch} title={t('series.aliasFetchHint')}>
                            {t('series.aliasFetch')}
                        </Button>
                    </div>
                    <form
                        className="mt-2 flex gap-2"
                        onSubmit={event => {
                            event.preventDefault();
                            void addAlias();
                        }}
                    >
                        <input
                            value={aliasInput}
                            onChange={event => setAliasInput(event.target.value)}
                            placeholder={t('series.aliasPlaceholder')}
                            className="min-w-0 flex-1 rounded-lg border border-line bg-surface/60 px-2.5 py-1.5 text-sm text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none"
                        />
                        <Button small type="submit" disabled={aliasInput.trim() === ''}>
                            {t('series.aliasAdd')}
                        </Button>
                    </form>
                    <div className="mt-1.5 text-xs text-faint">{t('series.aliasesHint')}</div>
                </div>
                {picker.loading ? (
                    <div className="mt-4 flex items-center gap-2 text-sm text-faint">
                        <Spinner /> {t('series.changeSourceSearching')}
                    </div>
                ) : picker.error ? (
                    <div className="mt-4 text-sm text-red-400">{picker.error}</div>
                ) : (picker.data?.alternatives.length ?? 0) === 0 ? (
                    <div className="mt-4 text-sm text-faint">
                        {t('series.changeSourceEmpty')}
                        {picker.data?.autoAliases && (
                            <div className="mt-1 text-xs text-faint">{t('series.changeSourceTriedAliases', { names: picker.data.autoAliases.join(', ') })}</div>
                        )}
                    </div>
                ) : (
                    <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                        {picker.data?.alternatives.map(alternative => (
                            <div
                                key={`${alternative.sourceId}:${alternative.mangaId}`}
                                className="flex items-center gap-3 rounded-lg border border-line bg-canvas/50 p-3"
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm text-fg">
                                        {alternative.sourceLabel}
                                        {alternative.mangaTitle !== entry.title && <span className="ml-1 text-faint">— {alternative.mangaTitle}</span>}
                                    </div>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                                        <span className="text-fg">{t('library.chaptersCount', { n: alternative.chapterCount })}</span>
                                        {alternative.chapterCount > entry.chapterCount && (
                                            <span className="text-emerald-400">
                                                {t('series.changeSourceMore', { n: alternative.chapterCount - entry.chapterCount })}
                                            </span>
                                        )}
                                        <span>{t('series.changeSourceMatch', { n: Math.round((alternative.score ?? 0) * 100) })}</span>
                                    </div>
                                </div>
                                <Button small onClick={() => migrateTo(alternative)} loading={migratingTo === alternative.sourceId}>
                                    {t('library.migrate')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
