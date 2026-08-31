/**
 * Tasks view: scheduled checks (cron, auto-download, auto-unfollow),
 * notifications, manual run and the maintenance tools — covers cache,
 * failed-source rematch and the better-source scan.
 */
import type { LibraryEntryDto, ScheduleSettingsDto, ScheduleStatusDto } from '@tanko/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/confirm.js';
import { IconBell, IconDownload, IconRefresh, IconSliders } from '../components/icons.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, Input, SectionTitle, Skeleton, Spinner, Toggle } from '../components/ui.js';
import type { TFunction } from '../i18n/index.js';
import { useI18n } from '../i18n/index.js';
import { api, type CoverStatusDto, type SchedulePatch } from '../lib/api.js';

const CRON_PRESETS: Array<{ value: string; key: Parameters<TFunction>[0] }> = [
    { value: '0 */6 * * *', key: 'schedule.cron6' },
    { value: '0 8,20 * * *', key: 'schedule.cronTwiceADay' },
    { value: '0 8 * * *', key: 'schedule.cronDaily' }
];

/** Accent section heading (checks / tools / notifications). */
function SectionHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent-soft">{icon}</span>
            {children}
        </h2>
    );
}

/** Settings row: label + hint on the left, switch on the right. */
function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
                <div className="text-sm font-medium">{label}</div>
                {hint && <div className="text-xs text-zinc-500">{hint}</div>}
            </div>
            <Toggle checked={checked} onChange={onChange} />
        </div>
    );
}

export default function Tasks({ schedule, library }: { schedule: ScheduleStatusDto | null; library: LibraryEntryDto[] }) {
    const { t, formatDate } = useI18n();
    const [settings, setSettings] = useState<ScheduleSettingsDto | null>(null);
    const [cron, setCron] = useState('');
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [covers, setCovers] = useState<CoverStatusDto | null>(null);
    const [regenBusy, setRegenBusy] = useState(false);
    const [rematchBusy, setRematchBusy] = useState(false);
    const [dlMissingBusy, setDlMissingBusy] = useState(false);
    const [confirmMissing, setConfirmMissing] = useState(false);
    const toast = useToast();

    // better-source scan: threshold + confirmation + eligible list (live)
    const [threshold, setThreshold] = useState(5);
    const [showEligible, setShowEligible] = useState(false);
    const [confirmScan, setConfirmScan] = useState(false);
    const eligible = library.filter(entry => !entry.hidden && !entry.migrationSuggestion && entry.chapterCount <= threshold);
    const failingCount = library.filter(entry => !entry.hidden && (entry.checkFailures ?? 0) > 0).length;
    // everything not on disk across the library ('new' + 'missing' + 'failed'),
    // mirroring the per-series "Download missing" action
    const pendingCount = library
        .filter(entry => !entry.hidden)
        .reduce((sum, entry) => sum + entry.newCount + (entry.missingCount ?? 0) + (entry.failedCount ?? 0), 0);

    useEffect(() => {
        api.schedule().then(data => {
            setSettings(data.settings);
            setCron(data.settings.cron);
        });
    }, []);

    // cover cache status: polled every few seconds while the view is open
    useEffect(() => {
        let alive = true;
        const poll = async () => {
            try {
                const status = await api.coversStatus();
                if (alive) {
                    setCovers(status);
                }
            } catch {
                /* keep the last known status */
            }
        };
        void poll();
        const timer = setInterval(poll, 3000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);

    const save = async (patch: SchedulePatch) => {
        setSaving(true);
        try {
            const data = await api.updateSchedule(patch);
            setSettings(data.settings);
            toast.success(t('schedule.saved'));
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const regenCovers = async () => {
        setRegenBusy(true);
        try {
            const result = await api.regenCovers();
            toast.info(result.started ? t('schedule.coversRegenStarted') : t('schedule.coversAlreadyRunning'));
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRegenBusy(false);
        }
    };

    const runNow = async () => {
        setRunning(true);
        try {
            const result = await api.runSchedule();
            if (result.alreadyRunning) {
                toast.info(t('tasks.bulkAlreadyRunning'));
            } else {
                toast.success(t('schedule.runDone', { checked: result.checked, new: result.newChapters }));
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRunning(false);
        }
    };

    const runRematchFailed = async () => {
        setRematchBusy(true);
        try {
            const result = await api.rematchFailed();
            if (result.started) {
                toast.info(t('library.rematchStarted', { n: result.count }));
            } else if (result.reason === 'already-running') {
                toast.info(t('tasks.bulkAlreadyRunning'));
            } else {
                toast.info(t('library.noFailedToRematch'));
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRematchBusy(false);
        }
    };

    /** Bulk 'download missing' across the whole library — same sweep as the
     *  per-series action: everything not on disk ('new' + 'missing' + 'failed'). */
    const runDownloadMissing = async () => {
        setConfirmMissing(false);
        setDlMissingBusy(true);
        try {
            const result = await api.downloadAllMissing();
            toast.success(t('series.chaptersQueued', { n: result.queued }));
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setDlMissingBusy(false);
        }
    };

    const runScan = async () => {
        // close the dialog first: its confirm button must not stay clickable during the request
        setConfirmScan(false);
        try {
            const result = await api.rematchIncomplete(threshold);
            if (result.started) {
                toast.info(t('tasks.betterSourcesStarted', { n: result.count }));
            } else if (result.reason === 'already-running') {
                toast.info(t('tasks.betterSourcesAlreadyRunning'));
            } else {
                toast.info(t('tasks.betterSourcesNoneEligible'));
            }
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    if (!settings) {
        return (
            <div className="space-y-6">
                <SectionTitle>{t('tasks.title')}</SectionTitle>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {['sk-a', 'sk-b'].map(key => (
                        <Card key={key} className="space-y-4 p-4">
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="h-3 w-2/3" />
                            <Skeleton className="h-8 w-full" />
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <SectionTitle
                right={
                    <div className="flex items-center gap-2">
                        {schedule?.enabled ? <Badge tone="green">{t('schedule.enabled')}</Badge> : <Badge tone="zinc">{t('schedule.disabled')}</Badge>}
                        <Button small variant="ghost" onClick={runNow} loading={running} title={t('schedule.autoCheckHint')}>
                            <IconRefresh size={13} /> {t('schedule.runNow')}
                        </Button>
                    </div>
                }
            >
                {t('tasks.title')}
            </SectionTitle>

            {/* next / last run at a glance */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-line bg-surface/60 px-4 py-3 text-xs text-muted">
                {[
                    [t('schedule.nextRun'), schedule?.nextRunAt ? formatDate(schedule.nextRunAt) : '—'],
                    [t('schedule.lastRun'), formatDate(schedule?.lastRunAt)],
                    [t('schedule.result'), schedule?.lastRunResult || '—']
                ].map(([label, value]) => (
                    <span key={label}>
                        {label} <span className="font-medium text-zinc-200">{value}</span>
                    </span>
                ))}
            </div>

            <section className="space-y-4">
                <SectionHeading icon={<IconSliders size={13} />}>{t('tasks.autoSection')}</SectionHeading>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <Card className="space-y-5 p-4">
                        <ToggleRow
                            label={t('schedule.autoCheck')}
                            hint={t('schedule.autoCheckHint')}
                            checked={settings.enabled}
                            onChange={value => save({ enabled: value })}
                        />

                        <div className="space-y-2">
                            <div className="text-sm font-medium">{t('schedule.frequency')}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {CRON_PRESETS.map(preset => (
                                    <button
                                        key={preset.value}
                                        type="button"
                                        onClick={() => {
                                            setCron(preset.value);
                                            save({ cron: preset.value });
                                        }}
                                        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${cron === preset.value ? 'border-orange-500 bg-orange-500/10 text-orange-400' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`}
                                    >
                                        {t(preset.key)}
                                    </button>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <Input className="min-w-0 flex-1" value={cron} onChange={setCron} placeholder="0 */6 * * *" />
                                <Button variant="ghost" onClick={() => save({ cron })} disabled={saving || cron === settings.cron}>
                                    {t('common.apply')}
                                </Button>
                            </div>
                        </div>
                    </Card>

                    <Card className="space-y-4 p-4">
                        <ToggleRow
                            label={t('schedule.autoDownload')}
                            hint={t('schedule.autoDownloadHint')}
                            checked={settings.autoDownload}
                            onChange={value => save({ autoDownload: value })}
                        />
                        <div className="border-t border-line pt-4">
                            <ToggleRow
                                label={t('schedule.autoUnfollow')}
                                hint={t('schedule.autoUnfollowHint')}
                                checked={settings.autoUnfollow}
                                onChange={value => save({ autoUnfollow: value })}
                            />
                        </div>
                    </Card>
                </div>
            </section>

            <section className="space-y-4">
                <SectionHeading icon={<IconRefresh size={13} />}>{t('tasks.toolsSection')}</SectionHeading>

                {/* featured: better-source scan */}
                <Card className="space-y-4 border-accent/25 bg-gradient-to-b from-accent/[0.06] to-surface/60 p-4">
                    <div>
                        <div className="text-sm font-medium">{t('tasks.betterSourcesTitle')}</div>
                        <div className="mt-0.5 max-w-2xl text-xs text-zinc-500">{t('tasks.betterSourcesHint')}</div>
                    </div>

                    <div className="flex flex-wrap items-end gap-3">
                        <label htmlFor="better-sources-threshold" className="block">
                            <span className="mb-1 block text-xs font-medium text-zinc-400">{t('tasks.betterSourcesThreshold')}</span>
                            <Input
                                id="better-sources-threshold"
                                type="number"
                                value={String(threshold)}
                                onChange={value => setThreshold(Math.min(50, Math.max(1, Math.trunc(Number(value) || 1))))}
                                className="w-20 text-center"
                            />
                        </label>
                        <div className="flex flex-wrap items-center gap-2 pb-0.5">
                            <Button onClick={() => setConfirmScan(true)} disabled={eligible.length === 0}>
                                <IconRefresh size={13} /> {t('tasks.betterSourcesScan', { n: eligible.length })}
                            </Button>
                            <Button variant="ghost" onClick={() => setShowEligible(shown => !shown)} disabled={eligible.length === 0}>
                                {showEligible ? t('tasks.betterSourcesListHide') : t('tasks.betterSourcesList')}
                            </Button>
                        </div>
                        {eligible.length === 0 && <div className="pb-2 text-xs text-faint">{t('tasks.betterSourcesNone')}</div>}
                    </div>

                    {showEligible && (
                        <div className="overflow-hidden rounded-lg border border-line bg-zinc-950/60">
                            <table className="w-full text-left text-xs">
                                <thead className="text-faint">
                                    <tr className="border-b border-line">
                                        <th className="px-3 py-2 font-medium">{t('tasks.colSeries')}</th>
                                        <th className="px-3 py-2 font-medium">{t('discover.source')}</th>
                                        <th className="px-3 py-2 text-right font-medium">{t('series.chaptersTitle')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-line/60 text-zinc-300">
                                    {eligible.map(entry => (
                                        <tr key={entry.id} className="hover:bg-zinc-900/60">
                                            <td className="px-3 py-1.5 font-medium text-zinc-200">{entry.title}</td>
                                            <td className="px-3 py-1.5 text-faint">{entry.sourceLabel}</td>
                                            <td className="px-3 py-1.5 text-right">
                                                <Badge tone="zinc">{t('import.chapterShort', { n: entry.chapterCount })}</Badge>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </Card>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    <Card className="flex h-full flex-col gap-3 p-4">
                        <div>
                            <div className="text-sm font-medium">{t('tasks.rematchFailedTitle')}</div>
                            <div className="mt-0.5 text-xs text-zinc-500">{t('library.rematchFailedHint')}</div>
                        </div>
                        <div className="mt-auto flex justify-end">
                            <Button small variant="ghost" onClick={runRematchFailed} loading={rematchBusy} disabled={failingCount === 0}>
                                <IconRefresh size={13} /> {t('library.rematchFailed', { n: failingCount })}
                            </Button>
                        </div>
                    </Card>

                    <Card className="flex h-full flex-col gap-3 p-4">
                        <div>
                            <div className="text-sm font-medium">{t('tasks.downloadMissingTitle')}</div>
                            <div className="mt-0.5 text-xs text-zinc-500">{t('tasks.downloadMissingHint')}</div>
                        </div>
                        <div className="mt-auto flex justify-end">
                            <Button small variant="ghost" onClick={() => setConfirmMissing(true)} loading={dlMissingBusy} disabled={pendingCount === 0}>
                                <IconDownload size={13} /> {t('tasks.downloadMissing', { n: pendingCount })}
                            </Button>
                        </div>
                    </Card>

                    <Card className="flex h-full flex-col gap-3 p-4">
                        <div>
                            <div className="text-sm font-medium">{t('schedule.coversTitle')}</div>
                            <div className="mt-0.5 text-xs text-zinc-500">{t('schedule.coversHint')}</div>
                        </div>
                        {covers && (
                            <div className="flex items-center gap-2 text-xs text-zinc-400">
                                {covers.running ? (
                                    <>
                                        <Spinner size={12} /> {t('schedule.coversProgress', { done: covers.done, total: covers.total })}
                                    </>
                                ) : covers.enabled ? (
                                    covers.total > 0 && t('schedule.coversResult', { done: covers.done, skipped: covers.skipped, failed: covers.failed })
                                ) : (
                                    t('schedule.coversDisabled')
                                )}
                            </div>
                        )}
                        <div className="mt-auto flex justify-end">
                            <Button small variant="ghost" onClick={regenCovers} loading={regenBusy} disabled={covers?.running || covers?.enabled === false}>
                                <IconRefresh size={13} /> {t('schedule.regenCovers')}
                            </Button>
                        </div>
                    </Card>
                </div>
            </section>

            <section className="space-y-4">
                <SectionHeading icon={<IconBell size={13} />}>{t('tasks.notificationsSection')}</SectionHeading>
                <Card className="space-y-4 p-4">
                    <ToggleRow
                        label={t('schedule.notifications')}
                        hint={t('schedule.notificationsHint')}
                        checked={settings.notifications?.enabled || false}
                        onChange={value => save({ notifications: { enabled: value } })}
                    />
                    <NotificationUrl value={settings.notifications?.webhookUrl || ''} onSave={value => save({ notifications: { webhookUrl: value } })} />
                    <div className="space-y-3 border-t border-line pt-4">
                        <div className="text-sm font-medium">{t('tasks.notifyEvents')}</div>
                        {(['newChapters', 'outages', 'migrations', 'scans'] as const).map(key => (
                            <ToggleRow
                                key={key}
                                label={t(`tasks.notify.${key}` as Parameters<typeof t>[0])}
                                // server default: only new chapters notify
                                checked={settings.notifications?.events?.[key] ?? key === 'newChapters'}
                                onChange={value => save({ notifications: { events: { [key]: value } } })}
                            />
                        ))}
                    </div>
                </Card>
            </section>

            <ConfirmDialog
                open={confirmScan}
                title={t('tasks.betterSourcesConfirmTitle', { n: eligible.length })}
                body={t('tasks.betterSourcesConfirmBody')}
                confirmLabel={t('tasks.betterSourcesConfirm')}
                danger={false}
                onConfirm={runScan}
                onCancel={() => setConfirmScan(false)}
            />

            <ConfirmDialog
                open={confirmMissing}
                title={t('tasks.downloadMissingConfirmTitle')}
                body={t('tasks.downloadMissingConfirmBody')}
                confirmLabel={t('tasks.downloadMissingConfirm')}
                danger={false}
                onConfirm={runDownloadMissing}
                onCancel={() => setConfirmMissing(false)}
            />
        </div>
    );
}

function NotificationUrl({ value, onSave }: { value: string; onSave: (value: string) => void }) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    return (
        <div className="flex gap-2">
            <Input
                className="min-w-0 flex-1"
                value={draft}
                onChange={setDraft}
                placeholder="https://discord.com/api/webhooks/... ou https://ntfy.sh/mon-topic"
            />
            <Button variant="ghost" onClick={() => onSave(draft)} disabled={draft === value}>
                OK
            </Button>
        </div>
    );
}
