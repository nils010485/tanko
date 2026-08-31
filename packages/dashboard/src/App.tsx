/**
 * Dashboard shell: sidebar navigation + live state shared across views.
 * The active tab is synced with the URL hash (#/library, …) so it survives
 * reloads and can be shared.
 */
import { type ComponentType, useEffect, useState } from 'react';

declare const __APP_VERSION__: string;

import {
    IconActivity,
    IconDownload,
    IconGlobe,
    IconImport,
    IconLibrary,
    IconMenu,
    type IconProps,
    IconSearch,
    IconSettings,
    IconTasks
} from './components/icons.js';
import { useI18n } from './i18n/index.js';
import { useLiveState } from './lib/live.js';
import { useHashRoute, useHashSeriesId } from './lib/router.js';
import Activity from './views/Activity.js';
import Discover from './views/Discover.js';
import Downloads from './views/Downloads.js';
import Import from './views/Import.js';
import Library from './views/Library.js';
import Series from './views/Series.js';
import Settings from './views/Settings.js';
import Sources from './views/Sources.js';
import Tasks from './views/Tasks.js';

type Tab = 'discover' | 'library' | 'downloads' | 'import' | 'sources' | 'tasks' | 'settings' | 'activity';

const TAB_ICONS: Record<Tab, ComponentType<IconProps>> = {
    discover: IconSearch,
    library: IconLibrary,
    downloads: IconDownload,
    import: IconImport,
    sources: IconGlobe,
    tasks: IconTasks,
    activity: IconActivity,
    settings: IconSettings
};
/** Sidebar grouping; `settings` lives in the sidebar footer. */
const NAV_SECTIONS: Array<{ labelKey: 'nav.sectionRead' | 'nav.sectionManage'; tabs: Tab[] }> = [
    { labelKey: 'nav.sectionRead', tabs: ['discover', 'library', 'downloads'] },
    { labelKey: 'nav.sectionManage', tabs: ['import', 'sources', 'tasks', 'activity'] }
];

const TAB_IDS = Object.keys(TAB_ICONS) as Tab[];

export default function App() {
    const [tab, setTab] = useHashRoute<Tab>('library', TAB_IDS);
    const [seriesId, navigateSeries] = useHashSeriesId();
    const [navOpen, setNavOpen] = useState(false);
    const [libraryFocusFilter, setLibraryFocusFilter] = useState<string | null>(null);
    const live = useLiveState();
    const { t } = useI18n();
    // becomes true 3s after mount: the offline banner may then show when the WS is down
    const [offlineReady, setOfflineReady] = useState(false);

    const totalNew = live.library.reduce((sum, entry) => sum + entry.newCount, 0);
    const activeLabel = t(`nav.${tab}`);

    useEffect(() => {
        document.title = `Tanko — ${activeLabel}`;
    }, [activeLabel]);

    useEffect(() => {
        const timer = setTimeout(() => setOfflineReady(true), 3000);
        return () => clearTimeout(timer);
    }, []);

    // entering the Activity tab marks the unread error counter as seen
    useEffect(() => {
        if (tab === 'activity') {
            live.markActivitySeen();
        }
    }, [tab, live.markActivitySeen]);

    // close the mobile navigation with Escape
    useEffect(() => {
        if (!navOpen) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setNavOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [navOpen]);

    const navigate = (next: Tab) => {
        setTab(next);
        setNavOpen(false);
    };

    const connectionDot = (
        <span className="relative flex h-2 w-2" title={live.connected ? t('app.connected') : t('app.connecting')}>
            {live.connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${live.connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
        </span>
    );

    const navBadge = (id: Tab) => {
        if (id === 'library' && totalNew > 0) {
            return (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the badge rides the keyboard-accessible tab button; clicking only adds the "new" filter
                <span
                    onClick={() => setLibraryFocusFilter('new')}
                    title={t('app.focusNewChapters')}
                    className="ml-auto rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-bold text-canvas"
                >
                    {totalNew}
                </span>
            );
        }
        if (id === 'downloads' && live.queueStatus && (live.queueStatus.active > 0 || live.queueStatus.queued > 0)) {
            const { active, queued } = live.queueStatus;
            const title = [t('downloads.activeCount', { n: active }), queued > 0 ? t('downloads.queuedCount', { n: queued }) : ''].filter(Boolean).join(' · ');
            return (
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-faint" title={title}>
                    {live.queueStatus.active > 0 && (
                        <>
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                            {live.queueStatus.active}
                        </>
                    )}
                    {live.queueStatus.queued > 0 && <span>+{live.queueStatus.queued}</span>}
                </span>
            );
        }
        if (id === 'activity' && live.unreadErrors > 0) {
            return <span className="ml-auto rounded-md border border-line px-1.5 py-0.5 text-[11px] font-semibold text-red-400">{live.unreadErrors}</span>;
        }
        return null;
    };

    const navButton = (id: Tab) => {
        const Icon = TAB_ICONS[id];
        return (
            <button
                key={id}
                type="button"
                onClick={() => navigate(id)}
                className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                    tab === id ? 'bg-surface font-medium text-fg' : 'text-muted hover:bg-surface/60 hover:text-fg'
                }`}
            >
                {tab === id && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" />}
                <Icon size={16} className={`shrink-0 ${tab === id ? 'text-accent-soft' : ''}`} />
                <span className="min-w-0 flex-1 truncate text-left">{t(`nav.${id}`)}</span>
                {navBadge(id)}
            </button>
        );
    };

    const logo = (
        <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-accent font-display text-lg font-extrabold text-canvas shadow-lg shadow-accent/25">
                単
            </div>
            <div className="min-w-0">
                <div className="font-display text-base font-bold leading-tight tracking-tight">Tanko</div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-faint">manga downloader</div>
            </div>
        </div>
    );

    return (
        <div className="flex min-h-screen">
            {/* Backdrop for the mobile navigation */}
            {navOpen && (
                // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the navigation also closes with Escape (document listener above)
                <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setNavOpen(false)} />
            )}

            {/* Sidebar */}
            <aside
                className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-none flex-col border-r border-line bg-canvas transition-transform lg:static lg:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
            >
                <div className="px-5 pb-5 pt-6">{logo}</div>
                <nav className="flex-1 overflow-y-auto px-3">
                    {NAV_SECTIONS.map(section => (
                        <div key={section.labelKey} className="pb-2">
                            <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-faint">{t(section.labelKey)}</div>
                            <div className="space-y-0.5">{section.tabs.map(navButton)}</div>
                        </div>
                    ))}
                </nav>
                <div className="border-t border-line px-3 py-3">
                    {navButton('settings')}
                    <div className="flex items-center gap-2 px-3 pt-2.5 text-[11px] text-faint">
                        {connectionDot}
                        <span className="truncate">
                            {live.connected ? t('app.connected') : t('app.connecting')} · v{__APP_VERSION__}
                        </span>
                    </div>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                {offlineReady && !live.connected && (
                    <div className="flex items-center justify-center gap-2 border-b border-accent/30 bg-accent/10 px-4 py-2 text-xs text-accent-soft">
                        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
                        {t('app.disconnected')}
                    </div>
                )}
                {/* Mobile top bar */}
                <header className="flex items-center gap-3 border-b border-line px-4 py-3 lg:hidden">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        aria-label={t('app.openMenu')}
                        className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-fg"
                    >
                        <IconMenu size={18} />
                    </button>
                    <div className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-accent font-display text-sm font-extrabold text-canvas">
                        単
                    </div>
                    <div className="min-w-0 font-display text-base font-bold tracking-tight">
                        Tanko
                        <span className="ml-2 inline-block max-w-full truncate align-middle text-sm font-normal text-faint">{activeLabel}</span>
                    </div>
                    <span className="ml-auto">{connectionDot}</span>
                </header>

                {/* Main content */}
                <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
                    <div className="mx-auto max-w-5xl">
                        {tab === 'discover' && (
                            <Discover onAddedToLibrary={live.refreshLibrary} onOpenSeries={navigateSeries} sourcesVersion={live.sourcesVersion} />
                        )}
                        {tab === 'library' && seriesId === null && (
                            <Library
                                library={live.library}
                                loaded={live.libraryLoaded}
                                refreshLibrary={live.refreshLibrary}
                                focusFilter={libraryFocusFilter}
                                onFocusFilterDone={() => setLibraryFocusFilter(null)}
                                onOpenSeries={navigateSeries}
                                onNavigateTab={navigate}
                            />
                        )}
                        {tab === 'library' && seriesId !== null && (
                            <Series
                                entryId={seriesId}
                                library={live.library}
                                libraryLoaded={live.libraryLoaded}
                                onBack={() => navigateSeries(null)}
                                refreshLibrary={live.refreshLibrary}
                            />
                        )}
                        {tab === 'downloads' && <Downloads library={live.library} onOpenSeries={navigateSeries} />}
                        {tab === 'import' && <Import onImported={live.refreshLibrary} />}
                        {tab === 'sources' && <Sources sourcesVersion={live.sourcesVersion} />}
                        {tab === 'tasks' && <Tasks schedule={live.schedule} library={live.library} />}
                        {tab === 'activity' && <Activity logs={live.logs} library={live.library} onOpenSeries={navigateSeries} />}
                        {tab === 'settings' && <Settings />}
                    </div>
                </main>
            </div>
        </div>
    );
}
