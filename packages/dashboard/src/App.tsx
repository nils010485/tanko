/**
 * Dashboard shell: sidebar navigation + live state shared across views.
 * The active tab is synced with the URL hash (#/library, …) so it survives
 * reloads and can be shared.
 */
import { useEffect, useState, type ComponentType } from 'react';
declare const __APP_VERSION__: string;
import { useLiveState } from './lib/live.js';
import { useHashRoute } from './lib/router.js';
import Discover from './views/Discover.js';
import Library from './views/Library.js';
import Downloads from './views/Downloads.js';
import Schedule from './views/Schedule.js';
import Settings from './views/Settings.js';
import Activity from './views/Activity.js';
import Import from './views/Import.js';
import { Badge } from './components/ui.js';
import {
    IconActivity, IconClock, IconDownload, IconImport, IconLibrary, IconMenu, IconSearch, IconSettings, type IconProps
} from './components/icons.js';
import { useI18n } from './i18n/index.js';

type Tab = 'discover' | 'library' | 'downloads' | 'import' | 'schedule' | 'settings' | 'activity';

const TABS: Array<{ id: Tab; icon: ComponentType<IconProps> }> = [
    { id: 'discover', icon: IconSearch },
    { id: 'library', icon: IconLibrary },
    { id: 'downloads', icon: IconDownload },
    { id: 'import', icon: IconImport },
    { id: 'schedule', icon: IconClock },
    { id: 'activity', icon: IconActivity },
    { id: 'settings', icon: IconSettings }
];

export default function App() {
    const [tab, setTab] = useHashRoute<Tab>('library', TABS.map(item => item.id));
    const [navOpen, setNavOpen] = useState(false);
    const live = useLiveState();
    const { t } = useI18n();

    const activeJobs = live.jobs.filter(job => job.status === 'downloading' || job.status === 'queued').length;
    const totalNew = live.library.reduce((sum, entry) => sum + entry.newCount, 0);
    const activeLabel = t(`nav.${tab}`);

    useEffect(() => {
        document.title = `Tanko — ${activeLabel}`;
    }, [activeLabel]);

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
            {navOpen && <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setNavOpen(false)} />}

            {/* Sidebar */}
            <aside className={`fixed inset-y-0 left-0 z-40 flex w-56 flex-none flex-col border-r border-line bg-zinc-950 transition-transform lg:static lg:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}>
                <div className="px-5 pb-4 pt-6">
                    <div className="text-xl font-bold tracking-tight">
                        Tan<span className="text-accent-soft">ko</span>
                    </div>
                    <div className="mt-0.5 text-xs text-faint">headless · dashboard</div>
                </div>
                <nav className="flex-1 space-y-1 px-3">
                    {TABS.map(item => {
                        const Icon = item.icon;
                        return (
                            <button
                                key={item.id}
                                onClick={() => navigate(item.id)}
                                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${tab === item.id ? 'bg-accent/10 font-medium text-accent-soft' : 'text-muted hover:bg-surface hover:text-zinc-200'}`}
                            >
                                <Icon size={16} />
                                <span className="flex-1 text-left">{t(`nav.${item.id}`)}</span>
                                {item.id === 'downloads' && activeJobs > 0 && <Badge tone="blue">{activeJobs}</Badge>}
                                {item.id === 'library' && totalNew > 0 && <Badge tone="orange">{totalNew}</Badge>}
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
                        {tab === 'discover' && <Discover onAddedToLibrary={live.refreshLibrary} />}
                        {tab === 'library' && <Library library={live.library} loaded={live.libraryLoaded} refreshLibrary={live.refreshLibrary} />}
                        {tab === 'downloads' && <Downloads library={live.library} />}
                        {tab === 'import' && <Import onImported={live.refreshLibrary} />}
                        {tab === 'schedule' && <Schedule schedule={live.schedule} />}
                        {tab === 'activity' && <Activity logs={live.logs} />}
                        {tab === 'settings' && <Settings />}
                    </div>
                </main>
            </div>
        </div>
    );
}
