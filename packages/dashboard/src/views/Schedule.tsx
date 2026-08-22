/**
 * Schedule view: cron configuration, auto-download toggle, notifications,
 * manual run, last/next run status and the thumbnail cache maintenance card.
 */

import type { ScheduleSettingsDto, ScheduleStatusDto } from '@tanko/shared';
import { useEffect, useState } from 'react';
import { IconRefresh } from '../components/icons.js';
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

export default function Schedule({ schedule }: { schedule: ScheduleStatusDto | null }) {
    const { t, formatDate } = useI18n();
    const [settings, setSettings] = useState<ScheduleSettingsDto | null>(null);
    const [cron, setCron] = useState('');
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [covers, setCovers] = useState<CoverStatusDto | null>(null);
    const [regenBusy, setRegenBusy] = useState(false);
    const toast = useToast();

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
            toast.success(t('schedule.runDone', { checked: result.checked, new: result.newChapters }));
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setRunning(false);
        }
    };

    if (!settings) {
        return (
            <div className="space-y-6">
                <SectionTitle>{t('schedule.title')}</SectionTitle>
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
            <SectionTitle>{t('schedule.title')}</SectionTitle>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="space-y-4 p-4">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-medium">{t('schedule.autoCheck')}</div>
                            <div className="text-xs text-zinc-500">{t('schedule.autoCheckHint')}</div>
                        </div>
                        <Toggle checked={settings.enabled} onChange={value => save({ enabled: value })} />
                    </div>
                    <div className="flex justify-end">
                        <Button small variant="ghost" onClick={runNow} loading={running} title={t('schedule.autoCheckHint')}>
                            <IconRefresh size={13} /> {t('schedule.runNow')}
                        </Button>
                    </div>

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

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-medium">{t('schedule.autoDownload')}</div>
                            <div className="text-xs text-zinc-500">{t('schedule.autoDownloadHint')}</div>
                        </div>
                        <Toggle checked={settings.autoDownload} onChange={value => save({ autoDownload: value })} />
                    </div>
                </Card>

                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('schedule.notifications')}</div>
                    <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-zinc-500">{t('schedule.notificationsHint')}</div>
                        <Toggle checked={settings.notifications?.enabled || false} onChange={value => save({ notifications: { enabled: value } })} />
                    </div>
                    <NotificationUrl value={settings.notifications?.webhookUrl || ''} onSave={value => save({ notifications: { webhookUrl: value } })} />

                    <div className="border-t border-zinc-800 pt-3 text-sm">
                        <div className="mb-2 font-medium">{t('schedule.state')}</div>
                        <div className="space-y-1 text-xs text-zinc-400">
                            <div>
                                {t('schedule.nextRun')} <span className="text-zinc-200">{schedule?.nextRunAt ? formatDate(schedule.nextRunAt) : '—'}</span>
                            </div>
                            <div>
                                {t('schedule.lastRun')} <span className="text-zinc-200">{formatDate(schedule?.lastRunAt)}</span>
                            </div>
                            <div>
                                {t('schedule.result')} <span className="text-zinc-200">{schedule?.lastRunResult || '—'}</span>
                            </div>
                            <div className="pt-1">
                                {schedule?.enabled ? <Badge tone="green">{t('schedule.enabled')}</Badge> : <Badge tone="zinc">{t('schedule.disabled')}</Badge>}
                            </div>
                        </div>
                    </div>
                </Card>

                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('schedule.maintenance')}</div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('schedule.coversTitle')}</div>
                            <div className="text-xs text-zinc-500">{t('schedule.coversHint')}</div>
                        </div>
                        <Button small variant="ghost" onClick={regenCovers} loading={regenBusy} disabled={covers?.running || covers?.enabled === false}>
                            <IconRefresh size={13} /> {t('schedule.regenCovers')}
                        </Button>
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
                </Card>
            </div>
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
