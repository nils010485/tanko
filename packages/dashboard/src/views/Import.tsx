/**
 * Import view: drives the server-side import job (scan -> match -> confirm ->
 * sync). All state lives server-side (SQLite) so the view can be closed and
 * reopened at any time — it simply polls the current job.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCheck, IconImport, IconPlay, IconRefresh, IconX } from '../components/icons.js';
import { Badge, Button, Card, EmptyState, Input, ProgressBar, SectionTitle } from '../components/ui.js';
import { type TFunction, useI18n } from '../i18n/index.js';
import { api, type ImportJobSeries, type ImportJobStatus } from '../lib/api.js';

const ACTIVE_STATUSES = new Set(['scanning', 'matching', 'syncing']);

export default function Import({ onImported }: { onImported: () => void }) {
    const { t } = useI18n();
    const [folderPath, setFolderPath] = useState('');
    const [autoConfirm, setAutoConfirm] = useState<'auto' | 'none'>('none');
    const [autoDownload, setAutoDownload] = useState(false);
    const [state, setState] = useState<ImportJobStatus | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const refresh = useCallback(async () => {
        try {
            setState(await api.importJobStatus());
        } catch {
            /* keep the last known state */
        }
    }, []);

    useEffect(() => {
        void refresh();
        pollRef.current = setInterval(refresh, 2000);
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [refresh]);

    const job = state?.job || null;
    const counters = state?.counters;
    const series = state?.series || [];
    const active = job ? ACTIVE_STATUSES.has(job.status) : false;
    const confirmedCount = counters?.confirmed || 0;

    const run = (action: () => Promise<unknown>) => async () => {
        setBusy(true);
        setError('');
        try {
            await action();
            await refresh();
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            setBusy(false);
        }
    };

    const start = run(() =>
        api.importJobStart({
            path: folderPath.trim(),
            autoConfirm,
            autoDownload
        })
    );
    // every job action is a no-op when there is no job (buttons are hidden then)
    const runJobAction = (action: (jobId: number) => Promise<unknown>) =>
        run(async () => {
            if (job) {
                await action(job.id);
            }
        });
    const resume = runJobAction(id => api.importJobResume(id));
    const cancel = runJobAction(id => api.importJobCancel(id));
    const confirmAuto = runJobAction(id => api.importJobConfirm(id, 'auto'));
    const confirmAll = runJobAction(id => api.importJobConfirm(id, 'all'));
    const sync = runJobAction(async id => {
        await api.importJobSync(id);
        onImported();
    });

    const choose = (item: ImportJobSeries, candidateKey: string) =>
        run(async () => {
            if (!job) {
                return;
            }
            const candidate = item.candidates.find(entry => `${entry.sourceId}:${entry.mangaId}` === candidateKey);
            if (candidate) {
                await api.importJobChoose(job.id, { path: item.path, ...candidate });
            }
        })();

    const phaseLabel: Record<string, Parameters<TFunction>[0]> = {
        scanning: 'import.phaseScanning',
        matching: 'import.phaseMatching',
        ready: 'import.phaseReady',
        syncing: 'import.phaseSyncing',
        done: 'import.phaseDone',
        error: 'import.phaseError'
    };

    return (
        <div className="space-y-4">
            <SectionTitle>{t('import.title')}</SectionTitle>
            <p className="-mt-3 mb-4 text-sm text-zinc-500">{t('import.intro')}</p>

            <Card className="p-4">
                <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-64 flex-1">
                        <label htmlFor="import-folder" className="mb-1 block text-xs text-zinc-500">
                            {t('import.folderLabel')}
                        </label>
                        <Input id="import-folder" value={folderPath} onChange={value => setFolderPath(value)} placeholder="/biblio" />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input
                            type="checkbox"
                            checked={autoConfirm === 'auto'}
                            disabled={active}
                            onChange={event => setAutoConfirm(event.target.checked ? 'auto' : 'none')}
                        />
                        {t('import.autoConfirmLabel')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-zinc-400">
                        <input type="checkbox" checked={autoDownload} disabled={active} onChange={event => setAutoDownload(event.target.checked)} />
                        {t('import.autoDownloadLabel')}
                    </label>
                    <Button onClick={start} disabled={!folderPath.trim() || active} loading={busy && active}>
                        <IconPlay size={13} /> {t('import.start')}
                    </Button>
                </div>
                {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
            </Card>

            {job && (
                <Card className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 text-sm">
                            <span className="font-medium">{t(phaseLabel[job.status])}</span>
                            <span className="ml-2 break-all text-xs text-zinc-500">
                                {job.root} · job #{job.id}
                            </span>
                        </div>
                        {active && (
                            <Button small variant="ghost" onClick={cancel}>
                                <IconX size={13} /> {t('import.interrupt')}
                            </Button>
                        )}
                        {(job.status === 'ready' || job.status === 'error') && !busy && (
                            <Button small variant="ghost" onClick={resume}>
                                <IconRefresh size={13} /> {t('import.resume')}
                            </Button>
                        )}
                    </div>
                    {job.error && <div className="mt-2 text-sm text-red-400">{job.error}</div>}

                    {counters && counters.total > 0 && (
                        <div className="mt-3 space-y-2">
                            <ProgressBar
                                value={
                                    job.status === 'syncing' || job.status === 'done'
                                        ? (100 * (counters.synced + counters.failed)) / Math.max(1, counters.confirmed)
                                        : (100 * counters.matched) / counters.total
                                }
                            />
                            <div className="flex flex-wrap gap-2 text-xs">
                                <Badge>{t('import.seriesCount', { n: counters.total })}</Badge>
                                {job.status !== 'syncing' && job.status !== 'done' && (
                                    <Badge tone="blue">{t('import.analyzedCount', { a: counters.matched, b: counters.total })}</Badge>
                                )}
                                <Badge tone="green">{t('import.confidentCount', { n: counters.auto })}</Badge>
                                <Badge tone="orange">{t('import.reviewCount', { n: counters.review })}</Badge>
                                <Badge tone="red">{t('import.notFoundCount', { n: counters.none })}</Badge>
                                <Badge tone="zinc">{t('import.confirmedCount', { n: counters.confirmed })}</Badge>
                                {(job.status === 'syncing' || job.status === 'done') && (
                                    <Badge tone="green">{t('import.syncedCount', { n: counters.synced })}</Badge>
                                )}
                                {counters.failed > 0 && <Badge tone="red">{t('import.failedCount', { n: counters.failed })}</Badge>}
                            </div>
                        </div>
                    )}

                    {job.status === 'ready' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {counters && counters.auto > counters.confirmed && (
                                <Button small variant="ghost" onClick={confirmAuto} loading={busy}>
                                    <IconCheck size={13} /> {t('import.confirmConfident')}
                                </Button>
                            )}
                            {counters && counters.review > 0 && (
                                <Button small variant="ghost" onClick={confirmAll} loading={busy}>
                                    <IconCheck size={13} /> {t('import.confirmAll')}
                                </Button>
                            )}
                            <Button small onClick={sync} disabled={confirmedCount === 0} loading={busy}>
                                <IconImport size={13} /> {t('import.sync', { n: confirmedCount })}
                            </Button>
                        </div>
                    )}
                </Card>
            )}

            {series.length > 0 && (
                <div className="space-y-2">
                    {series.map(item => (
                        <Card key={item.path} className="p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">{item.name}</div>
                                    <div className="truncate text-xs text-zinc-500">{item.path}</div>
                                </div>
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <Badge>{t('import.chapterShort', { n: item.chapterCount })}</Badge>
                                    {item.status === 'pending' && <Badge tone="zinc">{t('import.queuedBadge')}</Badge>}
                                    {item.status === 'matching' && <Badge tone="blue">{t('import.searchingBadge')}</Badge>}
                                    {item.confidence === 'auto' && item.status !== 'synced' && <Badge tone="green">{t('import.confidentBadge')}</Badge>}
                                    {item.confidence === 'review' && item.status !== 'synced' && <Badge tone="orange">{t('import.reviewBadge')}</Badge>}
                                    {item.confidence === 'none' && item.status === 'matched' && <Badge tone="red">{t('import.notFoundBadge')}</Badge>}
                                    {item.confirmed && item.status !== 'synced' && <Badge tone="blue">{t('import.confirmedBadge')}</Badge>}
                                    {item.status === 'synced' && (
                                        <Badge tone="green">
                                            {t('import.syncedBadge', { a: item.matched ?? 0, b: item.localChapters ?? 0 })}
                                            {item.matchMode === 'ordinal' ? ` ${t('import.ordinal')}` : ''}
                                        </Badge>
                                    )}
                                    {item.status === 'failed' && <Badge tone="red">{t('import.failedBadge')}</Badge>}
                                </div>
                            </div>

                            {item.error && <div className="mt-2 text-xs text-red-400">{item.error}</div>}

                            {!item.mangaTitle && item.candidates.length > 0 && job && job.status !== 'syncing' && (
                                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-zinc-800/40 px-3 py-2 text-sm">
                                    <span className="text-xs text-zinc-500">{t('import.chooseManually')}</span>
                                    <select
                                        className="min-w-0 max-w-full rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none"
                                        value=""
                                        onChange={event => choose(item, event.target.value)}
                                    >
                                        <option value="" disabled>
                                            —
                                        </option>
                                        {item.candidates.map(candidate => (
                                            <option key={`${candidate.sourceId}:${candidate.mangaId}`} value={`${candidate.sourceId}:${candidate.mangaId}`}>
                                                {candidate.mangaTitle} ({candidate.sourceLabel}, {Math.round(candidate.score * 100)}%)
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {item.mangaTitle && (
                                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-sm">
                                    <IconCheck size={14} className="text-emerald-400" />
                                    <span className="min-w-0 break-words text-zinc-300">{item.mangaTitle}</span>
                                    <Badge tone="zinc">{item.sourceLabel}</Badge>
                                    {item.score !== undefined && <Badge tone="zinc">{Math.round(item.score * 100)}%</Badge>}
                                    {item.candidates.length > 1 && job && job.status !== 'syncing' && item.status !== 'synced' && (
                                        <select
                                            className="ml-auto min-w-0 max-w-full rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none"
                                            value={`${item.sourceId}:${item.mangaId}`}
                                            onChange={event => choose(item, event.target.value)}
                                        >
                                            {item.candidates.map(candidate => (
                                                <option key={`${candidate.sourceId}:${candidate.mangaId}`} value={`${candidate.sourceId}:${candidate.mangaId}`}>
                                                    {candidate.mangaTitle} ({candidate.sourceLabel}, {Math.round(candidate.score * 100)}%)
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            )}
                        </Card>
                    ))}
                </div>
            )}

            {!job && <EmptyState title={t('import.empty')} hint={t('import.emptyHint')} />}
        </div>
    );
}
