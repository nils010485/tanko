/**
 * Source picker combobox of the Discover view: searchable list with health
 * dots, native-source stars and the hidden-sources toggle.
 */
import type { SourceDto } from '@tanko/shared';
import type React from 'react';
import type { TFunction } from '../../i18n/index.js';
import { useI18n } from '../../i18n/index.js';
import { IconCheck, IconChevronDown, IconEye, IconEyeOff, IconSearch, IconStar } from '../icons.js';
import { Badge } from '../ui.js';

/** Health status dot shown next to every source label. */
export function healthDot(health: string | undefined, t: TFunction) {
    switch (health) {
        case 'ok':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-emerald-400" title={t('discover.healthOk')} />;
        case 'error':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-red-400" title={t('discover.healthError')} />;
        case 'checking':
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-sky-400" title={t('discover.healthChecking')} />;
        default:
            return <span className="inline-block h-2 w-2 flex-none rounded-full bg-zinc-600" title={t('discover.healthUntested')} />;
    }
}

export function SourcePicker({
    sources,
    visibleSources,
    currentSource,
    sourceId,
    sourceQuery,
    comboOpen,
    showHidden,
    hiddenCount,
    dimmed,
    comboRef,
    onToggle,
    onQuery,
    onPick,
    onToggleShowHidden
}: {
    sources: SourceDto[];
    visibleSources: SourceDto[];
    currentSource: SourceDto | undefined;
    sourceId: string;
    sourceQuery: string;
    comboOpen: boolean;
    showHidden: boolean;
    hiddenCount: number;
    /** Dimmed while a global search ignores the picked source. */
    dimmed: boolean;
    comboRef: React.Ref<HTMLDivElement>;
    onToggle(): void;
    onQuery(value: string): void;
    onPick(source: SourceDto): void;
    onToggleShowHidden(): void;
}) {
    const { t } = useI18n();
    return (
        <div className={`relative ${dimmed ? 'opacity-60' : ''}`} ref={comboRef}>
            <button
                type="button"
                onClick={onToggle}
                className="flex h-10 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm transition-colors hover:border-zinc-600"
            >
                {currentSource ? (
                    <>
                        {healthDot(currentSource.health, t)}
                        <span className="max-w-40 truncate font-medium">{currentSource.label}</span>
                        {currentSource.kind === 'native' && <Badge tone="purple">{t('discover.native')}</Badge>}
                    </>
                ) : (
                    <span className="text-zinc-500">{t('discover.pickSource')}</span>
                )}
                <IconChevronDown size={16} className="text-zinc-500" />
            </button>

            {comboOpen && (
                <div className="absolute z-20 mt-2 w-80 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40">
                    <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
                        <IconSearch size={14} className="text-zinc-500" />
                        <input
                            // biome-ignore lint/a11y/noAutofocus: the combobox search should be focused as soon as it opens
                            autoFocus
                            value={sourceQuery}
                            onChange={event => onQuery(event.target.value)}
                            placeholder={t('discover.filterSources')}
                            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
                        />
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                        {visibleSources.map(source => (
                            <button
                                type="button"
                                key={source.id}
                                onClick={() => onPick(source)}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-800 ${source.id === sourceId ? 'bg-zinc-800/70' : ''}`}
                            >
                                {healthDot(source.health, t)}
                                <span className="flex-1 truncate">{source.label}</span>
                                {source.kind === 'native' && <IconStar size={13} className="text-violet-400" />}
                                {source.id === sourceId && <IconCheck size={14} className="text-orange-400" />}
                            </button>
                        ))}
                        {visibleSources.length === 0 && <div className="px-3 py-4 text-center text-sm text-zinc-500">{t('discover.noSourceMatch')}</div>}
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                        <span>
                            {showHidden ? t('discover.sourcesCount', { n: sources.length }) : t('discover.sourcesVisible', { n: sources.length - hiddenCount })}
                            {hiddenCount > 0 && ` · ${t('discover.hiddenCount', { n: hiddenCount })}`}
                        </span>
                        <button
                            type="button"
                            onClick={onToggleShowHidden}
                            className="flex items-center gap-1.5 text-zinc-400 transition-colors hover:text-zinc-200"
                        >
                            {showHidden ? (
                                <>
                                    <IconEyeOff size={13} /> {t('discover.hideHidden')}
                                </>
                            ) : (
                                <>
                                    <IconEye size={13} /> {t('discover.showHidden')}
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
