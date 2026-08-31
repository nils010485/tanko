/**
 * Sources view: dedicated admin table of every source, native (tanko) or
 * legacy (HakuNeko), with health status, latency, filters, per-source
 * probing and the same hide-broken / recheck-all tools as the Discover view.
 */

import type { SourceDto } from '@tanko/shared';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { healthDot } from '../components/discover/index.js';
import { IconChevronLeft, IconChevronRight, IconEye, IconEyeOff, IconGlobe, IconRefresh, IconSearch } from '../components/icons.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, ErrorBanner, IconButton, Input, SectionTitle, Spinner } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { sourceRank, statusLabel, statusTextClass } from '../lib/sources.js';

type KindFilter = 'all' | 'native' | 'legacy';
type HealthFilter = 'all' | 'ok' | 'error' | 'untested';
const PAGE_SIZE = 50;

export default function Sources({ sourcesVersion }: { sourcesVersion: number }) {
    const [sources, setSources] = useState<SourceDto[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState('');
    const [query, setQuery] = useState('');
    const [kind, setKind] = useState<KindFilter>('all');
    const [health, setHealth] = useState<HealthFilter>('all');
    const [showHidden, setShowHidden] = useState(false);
    const [rechecking, setRechecking] = useState(false);
    const [hidingBroken, setHidingBroken] = useState(false);
    const [probingId, setProbingId] = useState<string | null>(null);
    const toast = useToast();
    const { t, formatDate } = useI18n();

    const refreshSources = useCallback(async (): Promise<SourceDto[]> => {
        try {
            const list = await api.sources();
            setSources(list);
            setError('');
            return list;
        } catch (cause) {
            setError((cause as Error).message);
            return [];
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void refreshSources();
    }, [refreshSources]);
    // rolling health re-checks push sources.updated — refresh the statuses live
    const seenVersion = useRef(sourcesVersion);
    useEffect(() => {
        if (sourcesVersion === seenVersion.current) {
            return;
        }
        seenVersion.current = sourcesVersion;
        void refreshSources();
    }, [sourcesVersion, refreshSources]);

    const counts = useMemo(
        () => ({
            total: sources.length,
            ok: sources.filter(source => source.health === 'ok').length,
            error: sources.filter(source => source.health === 'error' && !source.hidden).length,
            hidden: sources.filter(source => source.hidden).length,
            native: sources.filter(source => source.kind === 'native').length
        }),
        [sources]
    );

    // deferred so typing in the search box does not block on re-filtering ~1300 rows
    const deferredQuery = useDeferredValue(query);
    const filtered = useMemo(() => {
        const needle = deferredQuery.trim().toLowerCase();
        return sources
            .filter(source => showHidden || !source.hidden)
            .filter(source => kind === 'all' || source.kind === kind)
            .filter(source => health === 'all' || (source.health || 'untested') === health)
            .filter(
                source =>
                    !needle ||
                    source.label.toLowerCase().includes(needle) ||
                    source.id.toLowerCase().includes(needle) ||
                    (source.url || '').toLowerCase().includes(needle) ||
                    source.tags.some(tag => tag.toLowerCase().includes(needle))
            )
            .sort((a, b) => sourceRank(a) - sourceRank(b) || a.label.localeCompare(b.label));
    }, [sources, deferredQuery, kind, health, showHidden]);

    // pagination: any filter change restarts at the first page (the stored
    // key detects it, no reset effect needed) and the page is clamped when
    // a refresh shrinks the filtered list (e.g. hide-broken)
    const filterKey = `${deferredQuery}|${kind}|${health}|${showHidden}`;
    const [nav, setNav] = useState({ key: '', page: 0 });
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(nav.key === filterKey ? nav.page : 0, pageCount - 1);
    const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const goTo = (next: number) => setNav({ key: filterKey, page: next });

    const recheckAll = async () => {
        setRechecking(true);
        try {
            await api.checkSources();
            toast.info(t('sources.recheckStarted'));
            // poll while the background probe refreshes statuses
            for (let i = 0; i < 40; i++) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                const list = await refreshSources();
                const stillChecking = list.some(source => source.health === 'checking');
                if (!stillChecking && i > 2) {
                    break;
                }
            }
        } finally {
            setRechecking(false);
        }
    };

    const hideBroken = async () => {
        setHidingBroken(true);
        try {
            await api.hideBroken();
            await refreshSources();
        } catch (cause) {
            toast.error((cause as Error).message);
        } finally {
            setHidingBroken(false);
        }
    };

    const probe = async (source: SourceDto) => {
        setProbingId(source.id);
        try {
            await api.checkSources([source.id]);
            // statuses come back through the sources.updated push; poll briefly
            // so the spinner survives until the row has a final status
            for (let i = 0; i < 20; i++) {
                await new Promise(resolve => setTimeout(resolve, 1500));
                const list = await refreshSources();
                if (list.find(item => item.id === source.id)?.health !== 'checking') {
                    break;
                }
            }
        } catch (cause) {
            toast.error((cause as Error).message);
        } finally {
            setProbingId(current => (current === source.id ? null : current));
        }
    };

    const chip = (active: boolean, label: string, onClick: () => void) => (
        <button
            key={label}
            type="button"
            onClick={onClick}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? 'border-accent/40 bg-accent/10 font-medium text-accent-soft' : 'border-line text-muted hover:bg-zinc-800 hover:text-zinc-200'}`}
        >
            {label}
        </button>
    );

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" small onClick={hideBroken} loading={hidingBroken} title={t('discover.hideBrokenHint')}>
                            <IconEyeOff size={14} /> {t('discover.hideBroken')} {counts.error > 0 && `(${counts.error})`}
                        </Button>
                        <Button variant="ghost" small onClick={recheckAll} loading={rechecking} title={t('discover.recheckAllHint')}>
                            <IconRefresh size={14} /> {t('discover.recheckAll')}
                        </Button>
                    </div>
                }
            >
                {t('nav.sources')}
            </SectionTitle>

            {error && <ErrorBanner message={error} onRetry={refreshSources} />}

            {/* summary */}
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <Badge tone="zinc">{t('sources.countTotal', { n: counts.total })}</Badge>
                <Badge tone="green">{t('sources.countOk', { n: counts.ok })}</Badge>
                {counts.error > 0 && <Badge tone="red">{t('sources.countError', { n: counts.error })}</Badge>}
                {counts.hidden > 0 && <Badge tone="zinc">{t('discover.hiddenCount', { n: counts.hidden })}</Badge>}
                <Badge tone="purple">{t('sources.countNative', { n: counts.native })}</Badge>
            </div>

            <Card className="overflow-hidden">
                {/* toolbar */}
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
                    <div className="relative min-w-48 flex-1">
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint">
                            <IconSearch size={14} />
                        </span>
                        <Input value={query} onChange={setQuery} placeholder={t('sources.search')} className="pl-8" />
                    </div>
                    <div className="flex items-center gap-1.5">
                        {chip(kind === 'all', t('sources.filterAll'), () => setKind('all'))}
                        {chip(kind === 'native', t('sources.filterNative'), () => setKind('native'))}
                        {chip(kind === 'legacy', t('sources.filterLegacy'), () => setKind('legacy'))}
                    </div>
                    <div className="flex items-center gap-1.5">
                        {chip(health === 'all', t('sources.filterAll'), () => setHealth('all'))}
                        {chip(health === 'ok', t('sources.filterOk'), () => setHealth('ok'))}
                        {chip(health === 'error', t('sources.filterError'), () => setHealth('error'))}
                        {chip(health === 'untested', t('sources.filterUntested'), () => setHealth('untested'))}
                    </div>
                    {counts.hidden > 0 && (
                        <Button
                            variant="ghost"
                            small
                            onClick={() => setShowHidden(current => !current)}
                            title={t(showHidden ? 'discover.hideHidden' : 'discover.showHidden')}
                        >
                            {showHidden ? <IconEyeOff size={13} /> : <IconEye size={13} />} {t('discover.hiddenCount', { n: counts.hidden })}
                        </Button>
                    )}
                </div>

                {/* table */}
                {!loaded ? (
                    <div className="flex items-center justify-center px-4 py-10 text-faint">
                        <Spinner />
                    </div>
                ) : filtered.length === 0 ? (
                    <EmptyState title={t('sources.empty')} icon={<IconGlobe size={24} />} />
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm">
                            <thead>
                                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
                                    <th className="px-3 py-2 font-medium">{t('sources.source')}</th>
                                    <th className="px-3 py-2 font-medium">{t('sources.type')}</th>
                                    <th className="px-3 py-2 font-medium">{t('sources.health')}</th>
                                    <th className="px-3 py-2 font-medium">{t('sources.lastCheck')}</th>
                                    <th className="px-3 py-2" />
                                </tr>
                            </thead>
                            <tbody>
                                {pageItems.map(source => {
                                    const checking = source.health === 'checking' || probingId === source.id;
                                    return (
                                        <tr
                                            key={source.id}
                                            className={`border-b border-line/60 last:border-0 hover:bg-zinc-800/40 ${source.hidden ? 'opacity-50' : ''}`}
                                        >
                                            <td className="max-w-64 px-3 py-2">
                                                <div className="flex items-center gap-2">
                                                    {healthDot(source.health, t)}
                                                    <span className="truncate font-medium" title={source.url || source.id}>
                                                        {source.label}
                                                    </span>
                                                    {source.url && (
                                                        <a
                                                            href={source.url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            title={t('sources.openSite')}
                                                            className="text-faint transition-colors hover:text-zinc-200"
                                                        >
                                                            <IconGlobe size={13} />
                                                        </a>
                                                    )}
                                                    {source.hidden && (
                                                        <span title={t('sources.hiddenHint')}>
                                                            <IconEyeOff size={13} className="text-faint" />
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="mt-0.5 truncate pl-4 text-xs text-faint">{source.id}</div>
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2">
                                                {source.kind === 'native' ? (
                                                    <Badge tone="purple">{t('discover.native')}</Badge>
                                                ) : (
                                                    <Badge tone="zinc">{t('sources.filterLegacy')}</Badge>
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2">
                                                <span className={statusTextClass(source.health)}>{statusLabel(source.health, t)}</span>
                                                {source.healthLatencyMs !== undefined && source.health === 'ok' && (
                                                    <span className="ml-1.5 text-xs text-faint">{t('sources.latencyMs', { n: source.healthLatencyMs })}</span>
                                                )}
                                            </td>
                                            <td className="whitespace-nowrap px-3 py-2 text-xs text-faint">
                                                {source.healthCheckedAt ? formatDate(source.healthCheckedAt) : t('sources.never')}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                                <IconButton
                                                    variant="ghost"
                                                    title={t('sources.probe')}
                                                    loading={checking}
                                                    disabled={checking}
                                                    onClick={() => probe(source)}
                                                >
                                                    <IconRefresh size={13} />
                                                </IconButton>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {/* footer */}
                <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-faint">
                    <span>{t('sources.shown', { n: filtered.length, total: sources.length })}</span>
                    {pageCount > 1 && (
                        <div className="flex items-center gap-2">
                            <IconButton variant="ghost" title={t('sources.prevPage')} disabled={safePage === 0} onClick={() => goTo(safePage - 1)}>
                                <IconChevronLeft size={14} />
                            </IconButton>
                            <span className="tabular-nums">{t('sources.page', { a: safePage + 1, b: pageCount })}</span>
                            <IconButton variant="ghost" title={t('sources.nextPage')} disabled={safePage >= pageCount - 1} onClick={() => goTo(safePage + 1)}>
                                <IconChevronRight size={14} />
                            </IconButton>
                        </div>
                    )}
                </div>
            </Card>
        </div>
    );
}
