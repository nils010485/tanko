/**
 * Settings view organized in tabbed sections: general, downloads, languages,
 * data & storage, sources. Edits go through a single sticky save bar;
 * interface language and cover cache apply instantly.
 */

import type { ConnectorsUpdateStatus, QueueSettingsDto } from '@tanko/shared';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmDialog } from '../components/confirm.js';
import { useToast } from '../components/toast.js';
import { Button, Card, Input, SectionTitle, Select, SettingRow, Skeleton, Toggle } from '../components/ui.js';
import { LANGUAGES, type TFunction, useI18n } from '../i18n/index.js';
import { api, formatBytes } from '../lib/api.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Parse a number input, clamped to >= 0 (empty input resets to 0). */
function toNonNegative(value: string): number {
    return Math.max(0, Number(value) || 0);
}

type Section = 'general' | 'downloads' | 'languages' | 'data' | 'sources';
type SettingsKey = Parameters<TFunction>[0];

const SECTIONS: Array<{ id: Section; labelKey: SettingsKey; descKey: SettingsKey }> = [
    { id: 'general', labelKey: 'settings.sectionGeneral', descKey: 'settings.sectionGeneralDesc' },
    { id: 'downloads', labelKey: 'settings.downloads', descKey: 'settings.sectionDownloadsDesc' },
    { id: 'languages', labelKey: 'settings.languages', descKey: 'settings.sectionLanguagesDesc' },
    { id: 'data', labelKey: 'settings.sectionData', descKey: 'settings.sectionDataDesc' },
    { id: 'sources', labelKey: 'settings.sources', descKey: 'settings.sectionSourcesDesc' }
];

/** Content languages offered as filter chips (ISO codes). */
const CONTENT_LANGUAGES: Array<{ code: string; key: SettingsKey }> = [
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
];

export default function Settings() {
    const [settings, setSettings] = useState<QueueSettingsDto | null>(null);
    const [draft, setDraft] = useState<QueueSettingsDto | null>(null);
    const [disk, setDisk] = useState<number | null>(null);
    const [languages, setLanguages] = useState<string[]>([]);
    const [savedLanguages, setSavedLanguages] = useState<string[]>([]);
    const [useCovers, setUseCovers] = useState(false);
    const [detectIncomplete, setDetectIncomplete] = useState(false);
    const [detectStalled, setDetectStalled] = useState(false);
    const [autoMigrateExact, setAutoMigrateExact] = useState(false);
    const [hideAdult, setHideAdult] = useState(false);
    const [confirmHideAdult, setConfirmHideAdult] = useState(false);
    const [section, setSection] = useState<Section>('general');
    const [confirmClear, setConfirmClear] = useState(false);
    const [updateStatus, setUpdateStatus] = useState<ConnectorsUpdateStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [updateMessage, setUpdateMessage] = useState('');
    const toast = useToast();
    const { t, language, setLanguage, formatDate } = useI18n();

    const load = useCallback(async () => {
        const data = await api.settings();
        setSettings(data.queue);
        setDraft(data.queue);
        setDisk(data.diskUsedBytes);
        setLanguages(data.preferredLanguages || []);
        setSavedLanguages(data.preferredLanguages || []);
        setUseCovers(data.useFirstChapterCovers ?? false);
        setDetectIncomplete(data.incompleteSourceDetection ?? false);
        setDetectStalled(data.stalledSourceDetection ?? false);
        setAutoMigrateExact(data.autoMigrateExactMatch ?? false);
        setHideAdult(data.hideAdultSources ?? false);
        setUpdateStatus(await api.sourcesUpdateStatus());
    }, []);

    useEffect(() => {
        load().catch(() => undefined);
    }, [load]);

    /** One save for the whole view: queue settings + language filter. */
    const save = async () => {
        try {
            const data = await api.updateSettings({ ...draft, preferredLanguages: languages });
            setSettings(data.queue);
            setSavedLanguages(data.preferredLanguages || []);
            toast.success(t('settings.saved'));
            await load();
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    /** Discard pending edits: restore the last saved queue settings and languages. */
    const cancel = () => {
        setDraft(settings);
        setLanguages(savedLanguages);
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

    /** Starved-source detection is applied server-side on toggle. */
    const toggleDetection = async (value: boolean) => {
        setDetectIncomplete(value);
        try {
            await api.updateSettings({ incompleteSourceDetection: value });
        } catch (error) {
            setDetectIncomplete(!value);
            toast.error((error as Error).message);
        }
    };

    /** Stalled-source detection is applied server-side on toggle. */
    const toggleStalledDetection = async (value: boolean) => {
        setDetectStalled(value);
        try {
            await api.updateSettings({ stalledSourceDetection: value });
        } catch (error) {
            setDetectStalled(!value);
            toast.error((error as Error).message);
        }
    };

    /** Exact-match auto-migration is applied server-side on toggle. */
    const toggleAutoMigrateExact = async (value: boolean) => {
        setAutoMigrateExact(value);
        try {
            await api.updateSettings({ autoMigrateExactMatch: value });
        } catch (error) {
            setAutoMigrateExact(!value);
            toast.error((error as Error).message);
        }
    };

    /** Turning the filter on asks for confirmation: mixed sources reduce search coverage. */
    const requestHideAdult = (value: boolean) => {
        if (value) {
            setConfirmHideAdult(true);
        } else {
            applyHideAdult(false);
        }
    };

    const applyHideAdult = async (value: boolean) => {
        setConfirmHideAdult(false);
        setHideAdult(value);
        try {
            await api.updateSettings({ hideAdultSources: value });
        } catch (error) {
            setHideAdult(!value);
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
            } catch {
                /* still restarting */
            }
            await sleep(2000);
        }
        setUpdateMessage(t('settings.unreachableAfterUpdate'));
    };

    if (!settings || !draft) {
        return (
            <div className="space-y-6">
                <SectionTitle>{t('settings.title')}</SectionTitle>
                <Skeleton className="h-9 w-full max-w-3xl" />
                <Card className="max-w-3xl space-y-4 p-5">
                    <Skeleton className="h-4 w-1/2" />
                    <Skeleton className="h-3 w-2/3" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                </Card>
            </div>
        );
    }

    /** Merge one field change into the draft queue settings. */
    const patchDraft = (patch: Partial<QueueSettingsDto>) => setDraft({ ...draft, ...patch });

    const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || JSON.stringify(languages) !== JSON.stringify(savedLanguages);
    const active = SECTIONS.find(item => item.id === section) ?? SECTIONS[0];

    return (
        <div className="space-y-6">
            <SectionTitle>{t('settings.title')}</SectionTitle>

            <div className="border-b border-line">
                <nav className="-mb-px flex gap-1 overflow-x-auto">
                    {SECTIONS.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setSection(item.id)}
                            className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                                section === item.id ? 'border-accent text-accent-soft' : 'border-transparent text-muted hover:border-faint hover:text-fg'
                            }`}
                        >
                            {t(item.labelKey)}
                        </button>
                    ))}
                </nav>
            </div>

            <Card className="max-w-3xl">
                <div className="border-b border-line px-5 py-4">
                    <h2 className="text-sm font-semibold">{t(active.labelKey)}</h2>
                    <p className="mt-0.5 text-xs text-faint">{t(active.descKey)}</p>
                </div>

                <div className="divide-y divide-line px-5">
                    {section === 'general' && (
                        <>
                            <SettingRow label={t('settings.interfaceLanguage')} hint={t('settings.interfaceLanguageHint')}>
                                <Select
                                    value={language}
                                    onChange={value => setLanguage(value as 'en' | 'fr')}
                                    options={LANGUAGES.map(item => ({ value: item.value, label: item.label }))}
                                />
                            </SettingRow>
                            <SettingRow label={t('settings.useFirstChapterCovers')} hint={t('settings.useFirstChapterCoversHint')}>
                                <Toggle checked={useCovers} onChange={toggleCovers} />
                            </SettingRow>
                            <SettingRow label={t('settings.incompleteSourceDetection')} hint={t('settings.incompleteSourceDetectionHint')}>
                                <Toggle checked={detectIncomplete} onChange={toggleDetection} />
                            </SettingRow>
                            <SettingRow label={t('settings.stalledSourceDetection')} hint={t('settings.stalledSourceDetectionHint')}>
                                <Toggle checked={detectStalled} onChange={toggleStalledDetection} />
                            </SettingRow>
                            <SettingRow label={t('settings.autoMigrateExactMatch')} hint={t('settings.autoMigrateExactMatchHint')}>
                                <Toggle checked={autoMigrateExact} onChange={toggleAutoMigrateExact} />
                            </SettingRow>
                        </>
                    )}

                    {section === 'downloads' && (
                        <>
                            <SettingRow label={t('settings.chapterFormat')} hint={t('settings.chapterFormatHint')}>
                                <Select
                                    value={draft.chapterFormat}
                                    onChange={value => patchDraft({ chapterFormat: value as QueueSettingsDto['chapterFormat'] })}
                                    options={[
                                        { value: 'cbz', label: t('settings.formatCbz') },
                                        { value: 'img', label: t('settings.formatImg') }
                                    ]}
                                />
                            </SettingRow>
                            <SettingRow label={t('settings.dataDirectory')} hint={t('settings.dataDirectoryHint')}>
                                <Input className="w-64" value={draft.dataDirectory} onChange={value => patchDraft({ dataDirectory: value })} />
                            </SettingRow>
                            <SettingRow label={t('settings.layout')} hint={t('settings.layoutHint')}>
                                <Select
                                    value={draft.directoryLayout ?? 'source'}
                                    onChange={value => patchDraft({ directoryLayout: value as 'source' | 'series' })}
                                    options={[
                                        { value: 'source', label: t('settings.layoutSource') },
                                        { value: 'series', label: t('settings.layoutSeries') }
                                    ]}
                                />
                            </SettingRow>
                            <SettingRow label={t('settings.parallelSources')} hint={t('settings.parallelSourcesHint')}>
                                <Select
                                    value={String(draft.parallelSources)}
                                    onChange={value => patchDraft({ parallelSources: Number(value) })}
                                    options={[1, 2, 3, 4].map(n => ({ value: String(n), label: String(n) }))}
                                />
                            </SettingRow>
                            <SettingRow
                                label={t('settings.concurrencyPerSource')}
                                hint={t('settings.concurrencyPerSourceHint', { total: draft.parallelSources * draft.concurrencyPerSource })}
                            >
                                <Select
                                    value={String(draft.concurrencyPerSource)}
                                    onChange={value => patchDraft({ concurrencyPerSource: Number(value) })}
                                    options={[1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: String(n) }))}
                                />
                            </SettingRow>
                            <SettingRow label={t('settings.throttle')} hint={t('settings.throttleHint')}>
                                <Input
                                    type="number"
                                    className="w-24"
                                    value={String(draft.throttleMs)}
                                    onChange={value => patchDraft({ throttleMs: toNonNegative(value) })}
                                />
                            </SettingRow>
                        </>
                    )}

                    {section === 'languages' && (
                        <div className="py-4">
                            <p className="mb-3 text-xs text-faint">{t('settings.languagesHint')}</p>
                            <div className="flex flex-wrap gap-2">
                                {CONTENT_LANGUAGES.map(item => {
                                    const selected = languages.includes(item.code);
                                    return (
                                        <button
                                            key={item.code}
                                            type="button"
                                            onClick={() => setLanguages(selected ? languages.filter(code => code !== item.code) : [...languages, item.code])}
                                            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                                                selected ? 'border-accent bg-accent/10 text-accent-soft' : 'border-line bg-line text-muted hover:border-faint'
                                            }`}
                                        >
                                            {t(item.key)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {section === 'data' && (
                        <>
                            <SettingRow label={t('settings.historyRetention')} hint={t('settings.historyRetentionHint')}>
                                <Input
                                    type="number"
                                    className="w-24"
                                    value={String(draft.historyRetentionDays)}
                                    onChange={value => patchDraft({ historyRetentionDays: toNonNegative(value) })}
                                />
                            </SettingRow>
                            <SettingRow label={t('settings.clearHistory')} hint={t('settings.clearHistoryHint')}>
                                <Button small variant="danger" onClick={() => setConfirmClear(true)}>
                                    {t('settings.clearHistory')}
                                </Button>
                            </SettingRow>
                            <div className="flex items-center justify-between gap-3 py-4">
                                <div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-2xl font-bold text-accent-soft">{disk !== null ? formatBytes(disk) : '…'}</span>
                                        <span className="text-sm text-faint">{t('settings.storageUsed')}</span>
                                    </div>
                                    <div className="mt-1 text-xs text-faint">
                                        {t('settings.currentFolder')} <code className="break-all text-muted">{settings.dataDirectory}</code>
                                    </div>
                                </div>
                                <Button small variant="ghost" onClick={load}>
                                    {t('settings.refresh')}
                                </Button>
                            </div>
                        </>
                    )}

                    {section === 'sources' && (
                        <>
                            <SettingRow label={t('settings.hideAdultSources')} hint={t('settings.hideAdultSourcesHint')}>
                                <Toggle checked={hideAdult} onChange={requestHideAdult} />
                            </SettingRow>
                            <div className="flex items-center justify-between gap-3 py-4">
                                <div>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-2xl font-bold text-accent-soft">{updateStatus ? updateStatus.activeCount : '…'}</span>
                                        <span className="text-sm text-faint">{t('settings.sourcesAvailable')}</span>
                                    </div>
                                    <div className="mt-1 text-xs text-faint">
                                        {t('settings.lastUpdate')}{' '}
                                        {updateStatus?.last
                                            ? `${formatDate(updateStatus.last.date)} · ${String(updateStatus.last.commit).slice(0, 7)}`
                                            : t('settings.never')}
                                    </div>
                                    {updateMessage && <div className="mt-1 text-xs text-sky-300">{updateMessage}</div>}
                                </div>
                                <Button loading={updating} onClick={updateSources} disabled={updating || !!updateStatus?.running}>
                                    {updating ? t('settings.updatingSources') : t('settings.updateSources')}
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            </Card>

            {dirty && (
                <div className="sticky bottom-4 z-10 flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-line bg-surface/95 px-5 py-3 shadow-lg shadow-black/40 backdrop-blur">
                    <span className="flex items-center gap-2 text-sm text-muted">
                        <span className="h-2 w-2 rounded-full bg-accent" />
                        {t('settings.unsavedChanges')}
                    </span>
                    <div className="flex gap-2">
                        <Button small variant="ghost" onClick={cancel}>
                            {t('common.cancel')}
                        </Button>
                        <Button small onClick={save}>
                            {t('common.save')}
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog
                open={confirmHideAdult}
                title={t('settings.hideAdultSources')}
                body={t('settings.hideAdultSourcesWarning')}
                confirmLabel={t('settings.hideAdultSourcesConfirm')}
                danger={false}
                onConfirm={() => applyHideAdult(true)}
                onCancel={() => setConfirmHideAdult(false)}
            />

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
