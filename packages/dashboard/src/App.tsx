/**
 * Dashboard shell: sidebar navigation + live state shared across views.
 * The active tab is synced with the URL hash (#/library, …) so it survives
 * reloads and can be shared.
 */
import { type ComponentType, useEffect, useState } from 'react';

declare const __APP_VERSION__: string;

import { IconActivity, IconDownload, IconImport, IconLibrary, IconMenu, type IconProps, IconSearch, IconSettings, IconTasks } from './components/icons.js';
import { Badge } from './components/ui.js';
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
import Tasks from './views/Tasks.js';

type Tab = 'discover' | 'library' | 'downloads' | 'import' | 'tasks' | 'settings' | 'activity';

const TABS: Array<{ id: Tab; icon: ComponentType<IconProps> }> = [
    { id: 'discover', icon: IconSearch },
    { id: 'library', icon: IconLibrary },
    { id: 'downloads', icon: IconDownload },
    { id: 'import', icon: IconImport },
    { id: 'tasks', icon: IconTasks },
    { id: 'activity', icon: IconActivity },
    { id: 'settings', icon: IconSettings }
];

const TAB_IDS = TABS.map(item => item.id);

export default function App() {
    const [tab, setTab] = useHashRoute<Tab>('library', TAB_IDS);
    const [seriesId, navigateSeries] = useHashSeriesId();
    const [navOpen, setNavOpen] = useState(false);
    const [libraryFocusFilter, setLibraryFocusFilter] = useState<string | null>(null);
    const live = useLiveState();
    const { t } = useI18n();

    const totalNew = live.library.reduce((sum, entry) => sum + entry.newCount, 0);
    const activeLabel = t(`nav.${tab}`);

    useEffect(() => {
        document.title = `Tanko — ${activeLabel}`;
    }, [activeLabel]);

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
        <span
            className={`inline-block h-2 w-2 rounded-full ${live.connected ? 'bg-emerald-400' : 'bg-red-400'}`}
            title={live.connected ? t('app.connected') : t('app.connecting')}
        />
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
                className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-none flex-col border-r border-line bg-zinc-950 transition-transform lg:static lg:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
            >
                <div className="px-5 pb-4 pt-6">
                    <div className="text-xl font-bold tracking-tight">
                        Tan<span className="text-accent-soft">ko</span>
                    </div>
                    <div className="mt-0.5 text-xs text-faint">manga downloader</div>
                </div>
                <nav className="flex-1 space-y-1 px-3">
                    {TABS.map(item => {
                        const Icon = item.icon;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => navigate(item.id)}
                                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${tab === item.id ? 'bg-accent/10 font-medium text-accent-soft' : 'text-muted hover:bg-surface hover:text-zinc-200'}`}
                            >
                                <Icon size={16} className="shrink-0" />
                                <span className="min-w-0 flex-1 truncate text-left">{t(`nav.${item.id}`)}</span>
                                {item.id === 'downloads' && live.queueStatus && live.queueStatus.active > 0 && (
                                    <span title={t('downloads.activeCount', { n: live.queueStatus.active })}>
                                        <Badge tone="blue">{live.queueStatus.active}</Badge>
                                    </span>
                                )}
                                {item.id === 'downloads' && live.queueStatus && live.queueStatus.queued > 0 && (
                                    <span title={t('downloads.queuedCount', { n: live.queueStatus.queued })}>
                                        <Badge tone="zinc">{live.queueStatus.queued}</Badge>
                                    </span>
                                )}
                                {item.id === 'library' && totalNew > 0 && (
                                    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the badge rides the keyboard-accessible tab button; clicking only adds the "new" filter
                                    <span onClick={() => setLibraryFocusFilter('new')} title={t('app.focusNewChapters')}>
                                        <Badge tone="orange">{totalNew}</Badge>
                                    </span>
                                )}
                                {item.id === 'activity' && live.unreadErrors > 0 && <Badge tone="red">{live.unreadErrors}</Badge>}
                            </button>
                        );
                    })}
                </nav>
                <div className="flex items-center gap-1.5 border-t border-line px-5 py-4 text-xs text-faint">
                    {connectionDot}
                    version {__APP_VERSION__}
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
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
                    <div className="min-w-0 text-base font-bold tracking-tight">
                        Tan<span className="text-accent-soft">ko</span>
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
                        {tab === 'downloads' && <Downloads library={live.library} />}
                        {tab === 'import' && <Import onImported={live.refreshLibrary} />}
                        {tab === 'tasks' && <Tasks schedule={live.schedule} library={live.library} />}
                        {tab === 'activity' && <Activity logs={live.logs} library={live.library} onOpenSeries={navigateSeries} />}
                        {tab === 'settings' && <Settings />}
                    </div>
                </main>
            </div>
        </div>
    );
}
