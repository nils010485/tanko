/**
 * Settings view: downloads (format, directory, concurrency, throttle), languages,
 * interface language, cover cache toggle, disk usage and source updates.
 */
import { useEffect, useState } from 'react';
import { api, formatBytes } from '../lib/api.js';
import { Button, Card, Input, SectionTitle, Select, Skeleton, Spinner, Toggle } from '../components/ui.js';
import { ConfirmDialog } from '../components/confirm.js';
import { useToast } from '../components/toast.js';
import { useI18n, LANGUAGES, type TFunction } from '../i18n/index.js';
import type { ConnectorsUpdateStatus, QueueSettingsDto } from '@tanko/shared';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function Settings() {
    const [settings, setSettings] = useState<QueueSettingsDto | null>(null);
    const [disk, setDisk] = useState<number | null>(null);
    const [draft, setDraft] = useState<QueueSettingsDto | null>(null);
    const toast = useToast();
    const { t, language, setLanguage, formatDate } = useI18n();
    const [updateStatus, setUpdateStatus] = useState<ConnectorsUpdateStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [updateMessage, setUpdateMessage] = useState('');
    const [languages, setLanguages] = useState<string[]>([]);
    const [useCovers, setUseCovers] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

    const load = async () => {
        const data = await api.settings();
        setSettings(data.queue);
        setDraft(data.queue);
        setDisk(data.diskUsedBytes);
        setLanguages(data.preferredLanguages || []);
        setUseCovers(data.useFirstChapterCovers ?? false);
        setUpdateStatus(await api.sourcesUpdateStatus());
    };

    useEffect(() => {
        load().catch(() => undefined);
    }, []);

    const save = async () => {
        try {
            const data = await api.updateSettings({ ...draft, preferredLanguages: languages });
            setSettings(data.queue);
            toast.success(t('settings.saved'));
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    /** The cover cache is applied server-side on toggle (enabling rebuilds it in the background). */
    const toggleCovers = async (value: boolean) => {
        setUseCovers(value);
        try {
            await api.updateSettings({ useFirstChapterCovers: value });
            if (value) {
                toast.info(t('schedule.coversRegenStarted'));
            }
        } catch (error) {
            setUseCovers(!value);
            toast.error((error as Error).message);
        }
    };

    /** Wipe the finished-job history after confirmation. */
    const clearHistory = async () => {
        setConfirmClear(false);
        try {
            const { removed } = await api.clearHistory();
            toast.success(t('settings.historyCleared', { n: removed }));
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    const updateSources = async () => {
        setUpdateMessage('');
        setUpdating(true);
        try {
            const { info, restart } = await api.updateSources();
            const diff = info.connectorCount - info.previousCount;
            let diffText = '';
            if (diff > 0) {
                diffText = ` (+${diff})`;
            } else if (diff < 0) {
                diffText = ` (${diff})`;
            }
            if (restart) {
                setUpdateMessage(t('settings.updatedRestarting', { n: info.connectorCount, diff: diffText }));
                await waitForRestart();
                location.reload();
                return;
            }
            setUpdateMessage(t('settings.updatedManual', { n: info.connectorCount, diff: diffText }));
        } catch (error) {
            setUpdateMessage(t('settings.errorPrefix', { msg: (error as Error).message }));
        } finally {
            setUpdating(false);
        }
    };

    /** Wait for the server to restart: give it time to exit, then poll /health until it answers again. */
    const waitForRestart = async () => {
        await sleep(3000);
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const response = await fetch('/health');
                if (response.ok) {
                    return;
                }
            } catch { /* still restarting */ }
            await sleep(2000);
        }
        setUpdateMessage(t('settings.unreachableAfterUpdate'));
    };

    if (!settings || !draft) {
        return (
            <div className="space-y-6">
                <SectionTitle>{t('settings.title')}</SectionTitle>
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {Array.from({ length: 2 }).map((_, index) => (
                        <Card key={index} className="space-y-4 p-4">
                            <Skeleton className="h-4 w-1/2" />
                            <Skeleton className="h-3 w-2/3" />
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                        </Card>
                    ))}
                </div>
            </div>
        );
    }

    const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

    return (
        <div className="space-y-6">
            <SectionTitle>{t('settings.title')}</SectionTitle>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('settings.downloads')}</div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.chapterFormat')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.chapterFormatHint')}</div>
                        </div>
                        <Select
                            value={draft.chapterFormat}
                            onChange={value => setDraft({ ...draft, chapterFormat: value as QueueSettingsDto['chapterFormat'] })}
                            options={[
                                { value: 'cbz', label: t('settings.formatCbz') },
                                { value: 'img', label: t('settings.formatImg') }
                            ]}
                        />
                    </div>

                    <div className="space-y-1">
                        <div className="text-sm">{t('settings.dataDirectory')}</div>
                        <div className="text-xs text-zinc-500">{t('settings.dataDirectoryHint')}</div>
                        <Input className="w-full" value={draft.dataDirectory} onChange={value => setDraft({ ...draft, dataDirectory: value })} />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.layout')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.layoutHint')}</div>
                        </div>
                        <Select
                            value={draft.directoryLayout ?? 'source'}
                            onChange={value => setDraft({ ...draft, directoryLayout: value as 'source' | 'series' })}
                            options={[
                                { value: 'source', label: t('settings.layoutSource') },
                                { value: 'series', label: t('settings.layoutSeries') }
                            ]}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.concurrency')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.concurrencyHint')}</div>
                        </div>
                        <Select
                            value={String(draft.concurrency)}
                            onChange={value => setDraft({ ...draft, concurrency: Number(value) })}
                            options={[1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: String(n) }))}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.throttle')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.throttleHint')}</div>
                        </div>
                        <input
                            type="number"
                            min={0}
                            step={50}
                            value={draft.throttleMs}
                            onChange={event => setDraft({ ...draft, throttleMs: Number(event.target.value) })}
                            className="w-24 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.historyRetention')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.historyRetentionHint')}</div>
                        </div>
                        <input
                            type="number"
                            min={0}
                            step={1}
                            value={draft.historyRetentionDays}
                            onChange={event => setDraft({ ...draft, historyRetentionDays: Number(event.target.value) })}
                            className="w-24 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.clearHistory')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.clearHistoryHint')}</div>
                        </div>
                        <Button small variant="danger" onClick={() => setConfirmClear(true)}>{t('settings.clearHistory')}</Button>
                    </div>

                    <div className="flex justify-end border-t border-zinc-800 pt-3">
                        <Button onClick={save} disabled={!dirty}>{t('common.save')}</Button>
                    </div>
                </Card>

                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('settings.languages')}</div>
                    <div className="text-xs text-zinc-500">
                        {t('settings.languagesHint')}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {([
                            { code: 'en', key: 'settings.languageEn' },
                            { code: 'fr', key: 'settings.languageFr' },
                            { code: 'es', key: 'settings.languageEs' },
                            { code: 'pt', key: 'settings.languagePt' },
                            { code: 'tr', key: 'settings.languageTr' },
                            { code: 'it', key: 'settings.languageIt' },
                            { code: 'de', key: 'settings.languageDe' },
                            { code: 'ru', key: 'settings.languageRu' },
                            { code: 'ja', key: 'settings.languageJa' },
                            { code: 'ko', key: 'settings.languageKo' },
                            { code: 'zh', key: 'settings.languageZh' }
                        ] as Array<{ code: string; key: Parameters<TFunction>[0] }>).map(language => {
                            const selected = languages.includes(language.code);
                            return (
                                <button
                                    key={language.code}
                                    type="button"
                                    onClick={() => setLanguages(selected
                                        ? languages.filter(code => code !== language.code)
                                        : [...languages, language.code])}
                                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${selected
                                        ? 'border-accent bg-accent/10 text-accent-soft'
                                        : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'}`}
                                >
                                    {t(language.key)}
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex justify-end border-t border-zinc-800 pt-3">
                        <Button onClick={save}>{t('common.save')}</Button>
                    </div>
                </Card>

                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('settings.interface')}</div>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.interfaceLanguage')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.interfaceLanguageHint')}</div>
                        </div>
                        <Select
                            value={language}
                            onChange={value => setLanguage(value as 'en' | 'fr')}
                            options={LANGUAGES.map(item => ({ value: item.value, label: item.label }))}
                        />
                    </div>
                </Card>
                <Card className="space-y-4 p-4">
                    <div className="text-sm font-medium">{t('settings.covers')}</div>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm">{t('settings.useFirstChapterCovers')}</div>
                            <div className="text-xs text-zinc-500">{t('settings.useFirstChapterCoversHint')}</div>
                        </div>
                        <Toggle checked={useCovers} onChange={toggleCovers} />
                    </div>
                </Card>

                <Card className="space-y-3 p-4">
                    <div className="text-sm font-medium">{t('settings.storage')}</div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-bold text-orange-400">{disk !== null ? formatBytes(disk) : '…'}</span>
                        <span className="text-sm text-zinc-500">{t('settings.storageUsed')}</span>
                    </div>
                    <div className="text-xs text-zinc-500">{t('settings.currentFolder')} <code className="break-all text-zinc-300">{settings.dataDirectory}</code></div>
                    <Button small variant="ghost" onClick={load}>{t('settings.refresh')}</Button>
                </Card>

                <Card className="space-y-3 p-4">
                    <div className="text-sm font-medium">{t('settings.sources')}</div>
                    <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-bold text-orange-400">{updateStatus ? updateStatus.activeCount : '…'}</span>
                        <span className="text-sm text-zinc-500">{t('settings.sourcesAvailable')}</span>
                    </div>
                    <div className="text-xs text-zinc-500">
                        {t('settings.lastUpdate')} {updateStatus?.last ? `${formatDate(updateStatus.last.date)} · ${String(updateStatus.last.commit).slice(0, 7)}` : t('settings.never')}
                    </div>
                    {updateMessage && <div className="text-xs text-sky-300">{updateMessage}</div>}
                    <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
                        {updating && <Spinner />}
                        <Button onClick={updateSources} disabled={updating || !!updateStatus?.running}>
                            {updating ? t('settings.updatingSources') : t('settings.updateSources')}
                        </Button>
                        <span className="text-xs text-zinc-500">{t('settings.updateSourcesHint')}</span>
                    </div>
                </Card>
            </div>

            <ConfirmDialog
                open={confirmClear}
                title={t('settings.clearHistory')}
                body={t('settings.clearHistoryConfirm')}
                onConfirm={clearHistory}
                onCancel={() => setConfirmClear(false)}
            />
        </div>
    );
}
