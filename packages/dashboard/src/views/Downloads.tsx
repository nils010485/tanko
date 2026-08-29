/**
 * Downloads view: paginated & filterable queue grouped in three sections
 * (active → queued → history), global pause, scoped cleanup menu (failed /
 * completed / whole history) and per-row cancel / retry / dismiss. The list is
 * self-managed (fetch + poll) so pagination survives live WebSocket updates.
 */

import type { DownloadJobDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cover } from '../components/Cover.js';
import { ConfirmDialog } from '../components/confirm.js';
import { IconChevronDown, IconDownload, IconPause, IconPlay, IconRefresh, IconTrash, IconX } from '../components/icons.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, IconButton, ProgressBar, SectionTitle, Skeleton } from '../components/ui.js';
import type { TFunction } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { useEscapeKey } from '../lib/hooks.js';

const PAGE_SIZE = 50;

const STATUS_FILTERS: Array<{ value: string; key: Parameters<TFunction>[0] }> = [
    { value: '', key: 'downloads.filterAll' },
    { value: 'queued', key: 'downloads.filterQueued' },
    { value: 'downloading', key: 'downloads.filterDownloading' },
    { value: 'completed', key: 'downloads.filterCompleted' },
    { value: 'failed', key: 'downloads.filterFailed' },
    { value: 'cancelled', key: 'downloads.filterCancelled' }
];

function statusBadge(status: string, t: TFunction) {
    switch (status) {
        case 'downloading':
            return <Badge tone="blue">{t('downloads.statusDownloading')}</Badge>;
        case 'queued':
            return <Badge tone="zinc">{t('downloads.statusQueued')}</Badge>;
        case 'completed':
            return <Badge tone="green">{t('downloads.statusCompleted')}</Badge>;
        case 'failed':
            return <Badge tone="red">{t('downloads.statusFailed')}</Badge>;
        case 'cancelled':
            return <Badge tone="zinc">{t('downloads.statusCancelled')}</Badge>;
        default:
            return <Badge tone="zinc">{status}</Badge>;
    }
}

/** Destructive actions available in the "Clean" menu. */
type CleanAction = 'queue' | 'failed' | 'completed' | 'all';

const HISTORY_JOB = new Set(['completed', 'failed', 'cancelled']);

export default function Downloads({ library, onOpenSeries }: { library: LibraryEntryDto[]; onOpenSeries?: (id: number) => void }) {
    const { t, formatDate } = useI18n();
    const [jobs, setJobs] = useState<DownloadJobDto[]>([]);
    const [total, setTotal] = useState(0);
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [loaded, setLoaded] = useState(false);
    const [page, setPage] = useState(0);
    const [status, setStatus] = useState('');
    const [query, setQuery] = useState('');
    const [queueStatus, setQueueStatus] = useState<{ paused: boolean; active: number; queued: number } | null>(null);
    const [sourceLabels, setSourceLabels] = useState<Record<string, string>>({});
    const toast = useToast();
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirm, setConfirm] = useState<CleanAction | null>(null);
    const [retrying, setRetrying] = useState(false);
    const [expandedErrors, setExpandedErrors] = useState<Set<number>>(new Set());
    const menuRef = useRef<HTMLDivElement>(null);

    const load = useCallback(async () => {
        try {
            const result = await api.downloads({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, status: status || undefined, q: query || undefined });
            setJobs(result.jobs);
            setTotal(result.total);
            setCounts(result.counts);
        } catch {
            /* transient — keep the last page */
        } finally {
            setLoaded(true);
        }
    }, [page, status, query]);

    useEffect(() => {
        setLoaded(false);
        load();
    }, [load]);

    useEffect(() => {
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
    }, [load]);

    useEffect(() => {
        const loadStatus = () =>
            api
                .downloadStatus()
                .then(setQueueStatus)
                .catch(() => undefined);
        loadStatus();
        const timer = setInterval(loadStatus, 4000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        api.sources()
            .then(list => {
                const map: Record<string, string> = {};
                for (const source of list) map[source.id] = source.label;
                setSourceLabels(map);
            })
            .catch(() => undefined);
    }, []);

    // close the clean menu on outside click
    useEffect(() => {
        if (!menuOpen) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [menuOpen]);

    useEscapeKey(() => setMenuOpen(false), menuOpen);

    const sourceName = (id: string) => sourceLabels[id] || id;
    const covers = new Map(library.map(entry => [entry.id, entry]));
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(page, pageCount - 1);

    const toggleQueue = () => {
        const request = queueStatus?.paused ? api.resumeQueue() : api.pauseQueue();
        request
            .then(state => {
                setQueueStatus(state);
                load();
            })
            .catch((error: Error) => toast.error(error.message));
    };

    /** Cancel an active job, or dismiss a finished one from the history. */
    const removeJob = async (job: DownloadJobDto) => {
        try {
            await api.removeJob(job.id);
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const retryJob = async (job: DownloadJobDto) => {
        try {
            await api.retryJob(job.id);
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const retryFailed = async () => {
        setRetrying(true);
        try {
            const result = await api.retryFailed();
            toast.info(t('downloads.retryFailedDone', { n: result.retried }));
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRetrying(false);
        }
    };

    const clean = async () => {
        if (!confirm) return;
        const action = confirm;
        setConfirm(null);
        try {
            if (action === 'queue') {
                const { cancelled, removed, paused, active, queued } = await api.clearQueue();
                toast.info(t('downloads.clearQueueDone', { n: removed + cancelled }));
                setQueueStatus({ paused, active, queued });
            } else {
                const { removed } = await api.clearHistory(action === 'all' ? undefined : action);
                toast.info(t('downloads.clearHistoryDone', { n: removed }));
            }
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const toggleError = (jobId: number) => {
        setExpandedErrors(prev => {
            const next = new Set(prev);
            if (next.has(jobId)) {
                next.delete(jobId);
            } else {
                next.add(jobId);
            }
            return next;
        });
    };

    const confirmCopy: Record<CleanAction, { title: string; body: string; label: string }> = {
        queue: { title: t('downloads.clearQueueTitle'), body: t('downloads.clearQueueConfirm'), label: t('downloads.clearQueue') },
        failed: { title: t('downloads.clearHistoryTitle'), body: t('downloads.clearFailedConfirm'), label: t('downloads.clearFailed') },
        completed: { title: t('downloads.clearHistoryTitle'), body: t('downloads.clearCompletedConfirm'), label: t('downloads.clearCompleted') },
        all: { title: t('downloads.clearHistoryTitle'), body: t('downloads.clearAllConfirm'), label: t('downloads.clearAllHistory') }
    };

    const menuItem = (action: CleanAction, label: string, count?: number, danger = false, disabled = false) => (
        <button
            key={action}
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={() => {
                setMenuOpen(false);
                setConfirm(action);
            }}
            className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-canvas hover:text-fg'
            }`}
        >
            <span className="whitespace-nowrap">{label}</span>
            {count !== undefined && <span className={danger ? 'text-red-400/60' : 'text-faint'}>{count}</span>}
        </button>
    );

    const renderJob = (job: DownloadJobDto) => {
        const active = job.status === 'queued' || job.status === 'downloading';
        const errorOpen = expandedErrors.has(job.id);
        // const local so TS keeps the non-null narrowing inside the closure
        const entryId = job.entryId;
        const openSeries = entryId != null && onOpenSeries ? () => onOpenSeries(entryId) : null;
        return (
            <Card key={job.id} className="group p-3">
                <div className="flex items-start gap-3">
                    <Cover
                        title={job.mangaTitle}
                        thumbnail={job.entryId != null ? covers.get(job.entryId)?.thumbnail : undefined}
                        coverUrl={job.entryId != null ? covers.get(job.entryId)?.coverUrl : undefined}
                        className="h-11 w-8 flex-none rounded"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            {openSeries ? (
                                <button
                                    type="button"
                                    className="truncate text-sm font-medium transition-colors hover:text-accent-soft"
                                    title={t('downloads.openSeriesHint')}
                                    onClick={openSeries}
                                >
                                    {job.mangaTitle}
                                </button>
                            ) : (
                                <span className="truncate text-sm font-medium">{job.mangaTitle}</span>
                            )}
                            <span className="truncate text-sm text-zinc-500">— {job.chapterTitle}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                            {statusBadge(job.status, t)}
                            {job.status === 'failed' && (job.autoRetries ?? 0) > 0 && (
                                <>
                                    <span>·</span>
                                    <span>{job.revalidating ? t('downloads.revalidating') : t('downloads.autoRetries', { n: job.autoRetries ?? 0 })}</span>
                                </>
                            )}
                            {job.pagesTotal > 0 && (
                                <>
                                    <span>{t('downloads.pagesCount', { done: job.pagesDone, total: job.pagesTotal })}</span>
                                    <span>·</span>
                                </>
                            )}
                            <span>{sourceName(job.sourceId)}</span>
                            <span>·</span>
                            <span>{formatDate(job.updatedAt)}</span>
                        </div>
                        {job.error && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => toggleError(job.id)}
                                    aria-expanded={errorOpen}
                                    className="mt-1 flex max-w-full items-center gap-1 text-left text-xs text-red-400/80 transition-colors hover:text-red-400"
                                >
                                    <IconChevronDown size={11} className={`flex-none transition-transform ${errorOpen ? 'rotate-180' : ''}`} />
                                    <span className="truncate">{job.error}</span>
                                </button>
                                {errorOpen && (
                                    <div className="mt-1 rounded-lg border border-red-400/15 bg-red-400/5 p-2 font-mono text-[11px] leading-relaxed break-all text-red-300/90">
                                        {job.error}
                                    </div>
                                )}
                            </>
                        )}
                        {job.status === 'downloading' && (
                            /* full-width within the column so nothing squeezes the title on narrow screens */
                            <div className="mt-2 flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <ProgressBar value={job.progress} />
                                </div>
                                <span className="w-10 flex-none text-right text-xs text-zinc-400">{job.progress}%</span>
                            </div>
                        )}
                    </div>
                    {/* actions: revealed on hover from sm up, always visible on touch screens */}
                    <div className="flex flex-none items-center gap-1.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                        {active && (
                            <IconButton variant="danger" title={t('downloads.cancel')} onClick={() => removeJob(job)}>
                                <IconX size={13} />
                            </IconButton>
                        )}
                        {!active && job.status !== 'completed' && (
                            <IconButton title={t('downloads.retry')} onClick={() => retryJob(job)}>
                                <IconRefresh size={13} />
                            </IconButton>
                        )}
                        {!active && (
                            <IconButton title={t('downloads.dismiss')} onClick={() => removeJob(job)}>
                                <IconTrash size={13} />
                            </IconButton>
                        )}
                    </div>
                </div>
            </Card>
        );
    };

    const groups: Array<{ key: string; label: string; jobs: DownloadJobDto[] }> = [
        { key: 'downloading', label: t('downloads.filterDownloading'), jobs: jobs.filter(job => job.status === 'downloading') },
        { key: 'queued', label: t('downloads.filterQueued'), jobs: jobs.filter(job => job.status === 'queued') },
        { key: 'history', label: t('downloads.groupHistory'), jobs: jobs.filter(job => HISTORY_JOB.has(job.status)) }
    ].filter(group => group.jobs.length > 0);

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <Button small variant={queueStatus?.paused ? 'primary' : 'ghost'} onClick={toggleQueue}>
                        {queueStatus?.paused ? <IconPlay size={13} /> : <IconPause size={13} />}
                        {queueStatus?.paused ? t('downloads.resume') : t('downloads.pauseAll')}
                    </Button>
                }
            >
                {t('downloads.title')} {queueStatus?.paused && <Badge tone="orange">{t('downloads.paused')}</Badge>}{' '}
                {queueStatus && queueStatus.active > 0 && <Badge tone="green">{t('downloads.activeCount', { n: queueStatus.active })}</Badge>}{' '}
                {queueStatus && queueStatus.queued > 0 && <Badge tone="zinc">{t('downloads.queuedCount', { n: queueStatus.queued })}</Badge>}
            </SectionTitle>

            <Card className="space-y-3 p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                        value={query}
                        onChange={event => {
                            setPage(0);
                            setQuery(event.target.value);
                        }}
                        placeholder={t('downloads.filterPlaceholder')}
                        className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm outline-none focus:border-accent"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <Button small variant="ghost" onClick={retryFailed} loading={retrying} disabled={!counts.failed} title={t('downloads.retryFailedHint')}>
                            <IconRefresh size={13} /> {t('downloads.retryFailed')}
                            {counts.failed ? <span className="text-faint">({counts.failed})</span> : null}
                        </Button>
                        <div className="relative" ref={menuRef}>
                            <Button
                                small
                                variant="ghost"
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                                onClick={() => setMenuOpen(open => !open)}
                                title={t('downloads.cleanHint')}
                            >
                                <IconTrash size={13} /> {t('downloads.clean')} <IconChevronDown size={12} />
                            </Button>
                            {menuOpen && (
                                <div
                                    role="menu"
                                    aria-label={t('downloads.clean')}
                                    className="absolute right-0 z-30 mt-1.5 w-60 max-w-[calc(100vw-3rem)] overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-xl shadow-black/50"
                                >
                                    {menuItem(
                                        'queue',
                                        t('downloads.clearQueue'),
                                        undefined,
                                        false,
                                        !(queueStatus && queueStatus.queued + queueStatus.active > 0)
                                    )}
                                    <div className="my-1 border-t border-line" />
                                    {menuItem('failed', t('downloads.clearFailed'), counts.failed ?? 0, false, !counts.failed)}
                                    {menuItem('completed', t('downloads.clearCompleted'), counts.completed ?? 0, false, !counts.completed)}
                                    <div className="my-1 border-t border-line" />
                                    {menuItem('all', t('downloads.clearAllHistory'), undefined, true)}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-1 border-t border-line pt-3">
                    {STATUS_FILTERS.map(filter => {
                        const count = filter.value === '' ? undefined : counts[filter.value];
                        return (
                            <button
                                key={filter.value}
                                type="button"
                                onClick={() => {
                                    setPage(0);
                                    setStatus(filter.value);
                                }}
                                className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                                    status === filter.value ? 'bg-accent/10 font-medium text-accent-soft' : 'text-muted hover:bg-canvas hover:text-zinc-200'
                                }`}
                            >
                                {t(filter.key)}
                                {count !== undefined && count > 0 ? ` (${count})` : ''}
                            </button>
                        );
                    })}
                </div>
            </Card>

            {!loaded && (
                <div className="space-y-2">
                    {['sk-a', 'sk-b', 'sk-c'].map(key => (
                        <Card key={key} className="flex items-center gap-3 p-3">
                            <Skeleton className="h-11 w-8 rounded" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-3.5 w-1/2" />
                                <Skeleton className="h-3 w-1/3" />
                            </div>
                            <Skeleton className="h-1.5 w-40" />
                        </Card>
                    ))}
                </div>
            )}

            {loaded && jobs.length === 0 && <EmptyState title={t('downloads.empty')} hint={t('downloads.emptyHint')} icon={<IconDownload size={28} />} />}

            <div className="space-y-4">
                {groups.map(group => (
                    <div key={group.key} className="space-y-2">
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-medium tracking-wide uppercase text-faint">{group.label}</span>
                            <span className="h-px flex-1 bg-line" />
                            <span className="text-xs text-faint">{group.jobs.length}</span>
                        </div>
                        {group.jobs.map(renderJob)}
                    </div>
                ))}
            </div>

            {pageCount > 1 && (
                <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-zinc-400">
                    <Button small variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
                        {t('downloads.previous')}
                    </Button>
                    <span>{t('downloads.pageSummary', { a: current + 1, b: pageCount, n: total })}</span>
                    <Button small variant="ghost" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                        {t('downloads.next')}
                    </Button>
                </div>
            )}
            {confirm && (
                <ConfirmDialog
                    open
                    title={confirmCopy[confirm].title}
                    body={confirmCopy[confirm].body}
                    confirmLabel={confirmCopy[confirm].label}
                    onConfirm={clean}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
