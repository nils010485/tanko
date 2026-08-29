/**
 * Library toolbar: title search, sort, view-mode switch (grid / compact /
 * list), display-preferences popover and the rich filter chips (new, missing
 * chapters, source/local gap, failing sources, stale checks, paused…).
 * Controlled component — filter/sort/view/prefs state stays in the Library
 * view because the filtered list and `focusFilter` depend on it.
 */
import type { LibraryEntryDto } from '@tanko/shared';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.js';
import {
    type DisplayPrefs,
    FILTER_IDS,
    FILTER_PREDS,
    type FilterId,
    GAP_THRESHOLD,
    type SortKey,
    STALE_DAYS,
    type ViewMode
} from '../../lib/library-filters.js';
import { IconChevronDown, IconGrid, IconGridSmall, IconList, IconSearch, IconSliders } from '../icons.js';
import { Button } from '../ui.js';

export function LibraryToolbar({
    filter,
    onFilterChange,
    sort,
    onSortChange,
    view,
    onViewChange,
    prefs,
    onPrefChange,
    activeFilters,
    onToggleFilter,
    onClearFilters,
    countsSource
}: {
    filter: string;
    onFilterChange: (value: string) => void;
    sort: SortKey;
    onSortChange: (sort: SortKey) => void;
    view: ViewMode;
    onViewChange: (view: ViewMode) => void;
    prefs: DisplayPrefs;
    onPrefChange: (key: keyof DisplayPrefs, value: boolean) => void;
    activeFilters: Set<FilterId>;
    onToggleFilter: (id: FilterId) => void;
    onClearFilters: () => void;
    countsSource: LibraryEntryDto[];
}) {
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [prefsOpen, setPrefsOpen] = useState(false);
    const prefsRef = useRef<HTMLDivElement>(null);
    const { t } = useI18n();

    // close the display popover when clicking outside
    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (prefsRef.current && !prefsRef.current.contains(event.target as Node)) {
                setPrefsOpen(false);
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    const viewButton = (mode: ViewMode, icon: React.ReactNode, label: string) => (
        <button
            key={mode}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => onViewChange(mode)}
            className={`px-2.5 py-1.5 transition-colors first:rounded-l-lg last:rounded-r-lg ${view === mode ? 'bg-zinc-800 text-fg' : 'text-muted hover:bg-zinc-800/60'}`}
        >
            {icon}
        </button>
    );

    const prefRow = (key: keyof DisplayPrefs, label: string) => (
        <label className="flex cursor-pointer items-center justify-between py-1.5 text-sm">
            <span>{label}</span>
            <input type="checkbox" checked={prefs[key]} onChange={event => onPrefChange(key, event.target.checked)} className="accent-orange-500" />
        </label>
    );

    const filterLabel = (id: FilterId): string => {
        switch (id) {
            case 'new':
                return t('library.filterNew');
            case 'missing':
                return t('library.filterMissing');
            case 'gap':
                return t('library.filterGap', { n: GAP_THRESHOLD });
            case 'failing':
                return t('library.filterFailing');
            case 'stale':
                return t('library.filterStale', { n: STALE_DAYS });
            case 'migration':
                return t('library.filterMigration');
            case 'paused':
                return t('library.filterPaused');
        }
    };

    return (
        <div className="rounded-xl border border-line bg-surface/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-40 flex-1">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
                        <IconSearch size={14} />
                    </span>
                    <input
                        value={filter}
                        onChange={event => onFilterChange(event.target.value)}
                        placeholder={t('library.filter')}
                        className="w-full rounded-lg border border-line bg-canvas py-1.5 pl-8 pr-3 text-sm outline-none focus:border-accent"
                    />
                </div>
                <select
                    value={sort}
                    onChange={event => onSortChange(event.target.value as SortKey)}
                    className="rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                >
                    <option value="recent">{t('library.sortRecent')}</option>
                    <option value="title">{t('library.sortTitle')}</option>
                    <option value="progress">{t('library.sortProgress')}</option>
                    <option value="new">{t('library.sortNew')}</option>
                    <option value="gap">{t('library.sortGap')}</option>
                </select>
                <div className="flex rounded-lg border border-line">
                    {viewButton('grid', <IconGrid size={14} />, t('library.viewGrid'))}
                    {viewButton('grid-compact', <IconGridSmall size={14} />, t('library.viewGridCompact'))}
                    {viewButton('list', <IconList size={14} />, t('library.viewList'))}
                </div>
                <div className="relative" ref={prefsRef}>
                    <Button small variant="ghost" title={t('library.display')} onClick={() => setPrefsOpen(current => !current)}>
                        <IconSliders size={13} /> {t('library.display')}
                    </Button>
                    {prefsOpen && (
                        <div className="absolute right-0 z-30 mt-2 w-60 rounded-xl border border-line bg-surface p-3 shadow-xl shadow-black/60">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{t('library.displayVisible')}</div>
                            {prefRow('progress', t('library.showProgress'))}
                            {prefRow('date', t('library.showDate'))}
                            {prefRow('source', t('library.showSource'))}
                            {prefRow('missing', t('library.showMissing'))}
                            <div className="mb-2 mt-3 text-xs font-semibold uppercase tracking-wide text-faint">{t('library.actionsGroup')}</div>
                            {prefRow('actions', t('library.showActions'))}
                        </div>
                    )}
                </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
                {/* mobile: chips collapse behind a toggle — active ones stay visible */}
                <button
                    type="button"
                    onClick={() => setFiltersOpen(current => !current)}
                    aria-expanded={filtersOpen}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-muted transition-colors hover:border-zinc-600 lg:hidden"
                >
                    <IconChevronDown size={12} className={`flex-none transition-transform ${filtersOpen ? 'rotate-180' : ''}`} />
                    {t('library.filtersToggle')}
                    {activeFilters.size > 0 && <span className="rounded-full bg-accent/10 px-1 text-[10px] text-accent-soft">{activeFilters.size}</span>}
                </button>
                {FILTER_IDS.map(id => {
                    const on = activeFilters.has(id);
                    const count = countsSource.filter(FILTER_PREDS[id]).length;
                    return (
                        <button
                            key={id}
                            type="button"
                            onClick={() => onToggleFilter(id)}
                            className={`items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                                on
                                    ? 'inline-flex border-accent/50 bg-accent/10 text-accent-soft'
                                    : `border-line bg-canvas text-muted hover:border-zinc-600 ${filtersOpen ? 'inline-flex' : 'hidden lg:inline-flex'}`
                            }`}
                        >
                            {filterLabel(id)}
                            <span className={`rounded-full px-1 text-[10px] ${on ? 'text-accent-soft' : 'text-faint'}`}>{count}</span>
                        </button>
                    );
                })}
                {activeFilters.size > 0 && (
                    <button type="button" onClick={onClearFilters} className="px-2 py-1 text-xs text-faint transition-colors hover:text-fg">
                        ✕ {t('library.filtersClear')}
                    </button>
                )}
            </div>
        </div>
    );
}
