/**
 * Downloads view: paginated & filterable queue (active first), global pause,
 * per-job cancel. The list is self-managed (fetch + poll) so pagination
 * survives live WebSocket updates.
 */

import type { DownloadJobDto, LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useState } from 'react';
import { Cover } from '../components/Cover.js';
import { ConfirmDialog } from '../components/confirm.js';
import { IconDownload, IconPause, IconPlay, IconRefresh, IconTrash, IconX } from '../components/icons.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, Skeleton } from '../components/ui.js';
import type { TFunction } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';

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

export default function Downloads({ library }: { library: LibraryEntryDto[] }) {
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
    const [confirmClear, setConfirmClear] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [retrying, setRetrying] = useState(false);

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

    const sourceName = (id: string) => sourceLabels[id] || id;
    const covers = new Map(library.map(entry => [entry.id, entry]));
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(page, pageCount - 1);

    const cancel = async (job: DownloadJobDto) => {
        try {
            await api.cancelJob(job.id);
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const clearQueue = async () => {
        setConfirmClear(false);
        setClearing(true);
        try {
            const { cancelled, removed, paused, active, queued } = await api.clearQueue();
            toast.info(t('downloads.clearQueueDone', { n: removed + cancelled }));
            await load();
            setQueueStatus({ paused, active, queued });
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setClearing(false);
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

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <div className="flex items-center gap-2">
                        {queueStatus?.paused ? (
                            <Button small onClick={() => api.resumeQueue().then(load)}>
                                <IconPlay size={13} /> {t('downloads.resume')}
                            </Button>
                        ) : (
                            <Button small variant="ghost" onClick={() => api.pauseQueue().then(load)}>
                                <IconPause size={13} /> {t('downloads.pauseAll')}
                            </Button>
                        )}
                        <Button small variant="ghost" onClick={retryFailed} loading={retrying} disabled={!counts.failed} title={t('downloads.retryFailedHint')}>
                            <IconRefresh size={13} /> {t('downloads.retryFailed')}
                        </Button>
                        <Button
                            small
                            variant="ghost"
                            onClick={() => setConfirmClear(true)}
                            loading={clearing}
                            disabled={queueStatus !== null && queueStatus.queued + queueStatus.active === 0}
                            title={t('downloads.clearQueueHint')}
                        >
                            <IconTrash size={13} /> {t('downloads.clearQueue')}
                        </Button>
                    </div>
                }
            >
                {t('downloads.title')} {queueStatus?.paused && <Badge tone="orange">{t('downloads.paused')}</Badge>}{' '}
                {queueStatus && queueStatus.queued > 0 && <Badge tone="zinc">{t('downloads.queuedCount', { n: queueStatus.queued })}</Badge>}{' '}
                {queueStatus && queueStatus.active > 0 && <Badge tone="green">{t('downloads.activeCount', { n: queueStatus.active })}</Badge>}
            </SectionTitle>

            <Card className="flex flex-wrap items-center gap-3 p-3">
                <input
                    value={query}
                    onChange={event => {
                        setPage(0);
                        setQuery(event.target.value);
                    }}
                    placeholder={t('downloads.filterPlaceholder')}
                    className="min-w-48 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <div className="flex flex-wrap items-center gap-1">
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
                                className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors ${status === filter.value ? 'bg-accent/10 font-medium text-accent-soft' : 'text-muted hover:bg-surface hover:text-zinc-200'}`}
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

            <div className="space-y-2">
                {jobs.map(job => (
                    <Card key={job.id} className="p-3">
                        <div className="flex items-start gap-3">
                            <Cover
                                title={job.mangaTitle}
                                thumbnail={job.entryId != null ? covers.get(job.entryId)?.thumbnail : undefined}
                                coverUrl={job.entryId != null ? covers.get(job.entryId)?.coverUrl : undefined}
                                className="h-11 w-8 flex-none rounded"
                            />
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium">{job.mangaTitle}</span>
                                    <span className="truncate text-sm text-zinc-500">— {job.chapterTitle}</span>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                                    {statusBadge(job.status, t)}
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
                                {/* progress under the text: full-width within the column so nothing
                                    squeezes the title on narrow screens */}
                                <div className="mt-2 flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <ProgressBar value={job.progress} />
                                    </div>
                                    <span className="w-10 flex-none text-right text-xs text-zinc-400">{job.progress}%</span>
                                </div>
                            </div>
                            {(job.status === 'queued' || job.status === 'downloading') && (
                                <Button small variant="danger" onClick={() => cancel(job)} title={t('downloads.cancel')}>
                                    <IconX size={13} />
                                </Button>
                            )}
                            {(job.status === 'failed' || job.status === 'cancelled') && (
                                <Button small variant="ghost" onClick={() => retryJob(job)} title={t('downloads.retry')}>
                                    <IconRefresh size={13} />
                                </Button>
                            )}
                        </div>
                        {job.error && <div className="mt-2 text-xs break-all text-red-400">{job.error}</div>}
                    </Card>
                ))}
            </div>

            {pageCount > 1 && (
                <div className="flex items-center justify-center gap-3 text-sm text-zinc-400">
                    <Button small variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
                        {t('downloads.previous')}
                    </Button>
                    <span>{t('downloads.pageSummary', { a: current + 1, b: pageCount, n: total })}</span>
                    <Button small variant="ghost" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                        {t('downloads.next')}
                    </Button>
                </div>
            )}
            <ConfirmDialog
                open={confirmClear}
                title={t('downloads.clearQueueTitle')}
                body={t('downloads.clearQueueConfirm')}
                confirmLabel={t('downloads.clearQueue')}
                onConfirm={clearQueue}
                onCancel={() => setConfirmClear(false)}
            />
        </div>
    );
}
