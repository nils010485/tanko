/**
 * Library view logic: filter/sort predicates, display preferences and view
 * helpers — pure functions persisted in localStorage, shared by the Library
 * view and its card components.
 */
import type { LibraryEntryDto } from '@tanko/shared';

export type ViewMode = 'grid' | 'grid-compact' | 'list';
export type SortKey = 'recent' | 'title' | 'progress' | 'new' | 'gap';
export type FilterId = 'new' | 'missing' | 'gap' | 'failing' | 'stale' | 'migration' | 'paused';

export interface DisplayPrefs {
    progress: boolean;
    date: boolean;
    source: boolean;
    missing: boolean;
    actions: boolean;
}

export const GAP_THRESHOLD = 10;
export const STALE_DAYS = 7;
export const VIEW_KEY = 'tanko.library.view';
export const PREFS_KEY = 'tanko.library.prefs';
export const DEFAULT_PREFS: DisplayPrefs = { progress: true, date: true, source: true, missing: true, actions: false };

export function missingCount(entry: LibraryEntryDto): number {
    return Math.max(0, entry.chapterCount - entry.downloadedCount);
}

export function progressOf(entry: LibraryEntryDto): number {
    return entry.chapterCount > 0 ? (entry.downloadedCount / entry.chapterCount) * 100 : 0;
}

function checkedAt(entry: LibraryEntryDto): number {
    return entry.lastCheckedAt ? Date.parse(entry.lastCheckedAt) : 0;
}

export function isStale(entry: LibraryEntryDto): boolean {
    return Date.now() - checkedAt(entry) > STALE_DAYS * 86_400_000;
}

export function progressTone(entry: LibraryEntryDto): 'orange' | 'green' {
    return entry.newCount > 0 ? 'orange' : 'green';
}

/** Column classes per grid view (kept literal for Tailwind's scanner). */
const GRID_CLASSES: Record<Exclude<ViewMode, 'list'>, string> = {
    grid: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
    'grid-compact': 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7'
};

export function gridClassName(view: ViewMode): string {
    return `grid gap-4 ${GRID_CLASSES[view === 'grid-compact' ? 'grid-compact' : 'grid']}`;
}

export const FILTER_IDS: FilterId[] = ['new', 'missing', 'gap', 'failing', 'stale', 'migration', 'paused'];
export const FILTER_PREDS: Record<FilterId, (entry: LibraryEntryDto) => boolean> = {
    new: entry => entry.newCount > 0,
    missing: entry => missingCount(entry) > 0,
    gap: entry => missingCount(entry) >= GAP_THRESHOLD,
    failing: entry => (entry.checkFailures ?? 0) > 0,
    stale: isStale,
    migration: entry => !!entry.migrationSuggestion,
    paused: entry => entry.paused === true
};
export const SORTERS: Record<SortKey, (a: LibraryEntryDto, b: LibraryEntryDto) => number> = {
    recent: (a, b) => checkedAt(b) - checkedAt(a),
    title: (a, b) => a.title.localeCompare(b.title),
    progress: (a, b) => progressOf(a) - progressOf(b),
    new: (a, b) => b.newCount - a.newCount,
    gap: (a, b) => missingCount(b) - missingCount(a)
};

export function loadView(): ViewMode {
    const view = localStorage.getItem(VIEW_KEY);
    return view === 'list' || view === 'grid-compact' ? view : 'grid';
}

export function loadPrefs(): DisplayPrefs {
    try {
        return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
    } catch {
        return DEFAULT_PREFS;
    }
}
