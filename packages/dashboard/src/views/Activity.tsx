/**
 * Activity view: structured event journal (level/category filters, entity
 * links, migration suggestions to confirm or dismiss) + system pulse and
 * the running background jobs.
 */
import type { ActivityJobsDto, ActivityStatsDto, JobStatusDto, LibraryEntryDto, LogCategory } from '@tanko/shared';
import { type ComponentType, useEffect, useMemo, useRef, useState } from 'react';
import { IconActivity, IconArrowLeftRight, IconCheck, IconGlobe, type IconProps, IconRefresh, IconSettings } from '../components/icons.js';
import { useToast } from '../components/toast.js';
import { Badge, Button, Card, EmptyState, Input, ProgressBar, SectionTitle } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import type { LogLine } from '../lib/live.js';

/** Lucide icon per event family. */
const CATEGORY_ICONS: Record<LogCategory, ComponentType<IconProps>> = {
    check: IconCheck,
    source: IconGlobe,
    failover: IconArrowLeftRight,
    scan: IconRefresh,
    system: IconSettings
};

const CATEGORIES: LogCategory[] = ['check', 'source', 'failover', 'scan', 'system'];
const LEVELS = ['all', 'info', 'warn', 'error'] as const;

/** Log codes whose suggestion may still be awaiting confirmation. */
const SUGGESTION_CODES = new Set([
    'failover.rematch.suggested',
    'scan.betterSources.suggested',
    'failover.downloadFailures.suggested',
    'failover.afterCheckFailures.suggested'
]);

/** Pulse counter card. */
function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'emerald' | 'orange' }) {
    const colors = { default: 'text-fg', emerald: 'text-emerald-400', orange: 'text-accent-soft' };
    return (
        <div className="rounded-xl border border-line bg-surface/60 px-4 py-3">
            <div className={`text-lg font-semibold ${colors[tone]}`}>{value}</div>
            <div className="text-[11px] text-faint">{label}</div>
        </div>
    );
}

/** Icon + label heading shared by the running/history job sections. */
function JobsHeading({ children }: { children: string }) {
    return (
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent-soft">
                <IconRefresh size={13} />
            </span>
            {children}
        </h2>
    );
}

export default function Activity({ logs, library, onOpenSeries }: { logs: LogLine[]; library: LibraryEntryDto[]; onOpenSeries: (entryId: number) => void }) {
    const { t, language } = useI18n();
    const toast = useToast();
    const [stats, setStats] = useState<ActivityStatsDto | null>(null);
    const [jobs, setJobs] = useState<ActivityJobsDto>({ running: [], history: [] });
    const [level, setLevel] = useState<(typeof LEVELS)[number]>('all');
    const [categories, setCategories] = useState<Set<LogCategory>>(new Set());
    const [query, setQuery] = useState('');
    const [older, setOlder] = useState<LogLine[]>([]);
    const [busy, setBusy] = useState<number | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const nextOffset = useRef<number | null>(null);

    /** t() with a dynamic key (event codes) — unknown keys render as-is. */
    const tt = (key: string, params?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], params);

    /** Job display name — translated from `kind`, falling back to the server label. */
    const jobLabel = (job: JobStatusDto) => {
        const key = `activity.jobKind.${job.kind}`;
        const translated = tt(key);
        return translated === key ? job.label : translated;
    };

    // system pulse + running jobs, polled while the view is open
    useEffect(() => {
        let alive = true;
        const poll = async () => {
            try {
                const [statsResult, jobsResult] = await Promise.all([api.activityStats(), api.activityJobs()]);
                if (alive) {
                    setStats(statsResult);
                    setJobs(jobsResult);
                }
            } catch {
                /* keep the last known values */
            }
        };
        void poll();
        const timer = setInterval(poll, 3000);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, []);

    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        // match the displayed (translated) text and the raw fallback message alike
        const text = (log: LogLine) => (log.code ? t(`activity.${log.code}` as Parameters<typeof t>[0], log.params) : log.message);
        return [...logs, ...older].filter(
            log =>
                (level === 'all' || log.level === level) &&
                (categories.size === 0 || categories.has(log.category ?? 'system')) &&
                (!needle || text(log).toLowerCase().includes(needle) || log.message.toLowerCase().includes(needle))
        );
    }, [logs, older, level, categories, query, t]);

    // group by calendar day, preserving the newest-first order
    const groups = useMemo(() => {
        const byDay = new Map<string, LogLine[]>();
        for (const log of visible) {
            const day = log.at.slice(0, 10);
            const list = byDay.get(day);
            if (list) {
                list.push(log);
            } else {
                byDay.set(day, [log]);
            }
        }
        return [...byDay.entries()];
    }, [visible]);

    const dayLabel = (day: string) => {
        const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
        if (day === iso(0)) {
            return t('activity.today');
        }
        if (day === iso(-1)) {
            return t('activity.yesterday');
        }
        return new Date(`${day}T12:00:00`).toLocaleDateString(language === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    };

    const cancelJob = async (jobId: number) => {
        try {
            await api.cancelJob(jobId);
            toast.info(t('activity.jobs.cancelSent'));
        } catch (error) {
            toast.error((error as Error).message);
        }
    };

    /** Confirm or dismiss a pending migration suggestion straight from the feed. */
    const answerSuggestion = async (entryId: number, apply: boolean) => {
        setBusy(entryId);
        try {
            const result = await api.confirmRematch(entryId, apply);
            if (apply) {
                toast.success(
                    t('library.migratedKept', {
                        title: library.find(entry => entry.id === entryId)?.title ?? '',
                        kept: result.kept ?? 0,
                        total: result.total ?? 0
                    })
                );
            } else {
                toast.info(t('activity.suggestionDismissed'));
            }
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setBusy(null);
        }
    };

    /** Append the next (older) page — the WS stream keeps feeding the top. */
    const loadMore = async () => {
        if (loadingMore) {
            return; // double click: one request at a time, the offset only advances once
        }
        setLoadingMore(true);
        if (nextOffset.current === null) {
            nextOffset.current = logs.length;
        }
        try {
            const result = await api.activity({ limit: 50, offset: nextOffset.current });
            setOlder(current => {
                const known = new Set([...logs, ...current].map(log => log.id));
                return [...current, ...result.logs.filter(log => !known.has(log.id))];
            });
            nextOffset.current += result.logs.length;
        } catch (error) {
            toast.error((error as Error).message);
        } finally {
            setLoadingMore(false);
        }
    };

    const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(language === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

    return (
        <div className="space-y-6">
            <SectionTitle>{t('activity.title')}</SectionTitle>

            {/* system pulse */}
            {stats && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat label={t('activity.pulse.series')} value={String(stats.series)} />
                    <Stat label={t('activity.pulse.newChapters')} value={String(stats.newChapters7d)} tone="emerald" />
                    <Stat label={t('activity.pulse.failures')} value={String(stats.activeFailures)} tone={stats.activeFailures > 0 ? 'orange' : 'default'} />
                    <Stat label={t('activity.pulse.sources')} value={`${stats.sourcesHealthy} / ${stats.sourcesTotal}`} />
                </div>
            )}

            {/* running jobs */}
            {jobs.running.length > 0 && (
                <section className="space-y-3">
                    <JobsHeading>{t('activity.jobs.title')}</JobsHeading>
                    {jobs.running.map(job => (
                        <Card key={job.id} className="space-y-3 border-accent/25 bg-gradient-to-b from-accent/5 to-transparent p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <div className="font-medium">{jobLabel(job)}</div>
                                <div className="flex items-center gap-2 text-xs text-muted">
                                    <span>{t('activity.jobs.progress', { done: job.done, total: job.total, hits: job.hits })}</span>
                                    <Button small variant="ghost" onClick={() => cancelJob(job.id)}>
                                        {t('activity.jobs.cancel')}
                                    </Button>
                                </div>
                            </div>
                            <ProgressBar value={(job.done / Math.max(1, job.total)) * 100} />
                        </Card>
                    ))}
                </section>
            )}

            {/* recent jobs */}
            {jobs.history.length > 0 && (
                <section className="space-y-3">
                    <JobsHeading>{t('activity.jobs.history')}</JobsHeading>
                    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface/60 text-xs">
                        {jobs.history.map(job => (
                            <li key={job.id} className="flex items-center justify-between gap-2 px-3 py-2">
                                <span className="min-w-0 truncate font-medium text-fg">{jobLabel(job)}</span>
                                <span className="flex shrink-0 items-center gap-2 text-muted">
                                    {job.cancelled && <Badge tone="orange">{t('activity.jobs.cancelled')}</Badge>}
                                    <span>{t('activity.jobs.historyCounts', { done: job.done, total: job.total, hits: job.hits })}</span>
                                    <span>{timeOf(job.finishedAt ?? job.startedAt)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* filters */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex overflow-hidden rounded-lg border border-line bg-card text-xs">
                    {LEVELS.map(value => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => setLevel(value)}
                            className={`px-2.5 py-1.5 transition-colors ${level === value ? 'bg-accent/10 font-medium text-accent-soft' : 'text-muted hover:text-fg'}`}
                        >
                            {tt(`activity.level.${value}`)}
                        </button>
                    ))}
                </div>
                {CATEGORIES.map(category => {
                    const Icon = CATEGORY_ICONS[category];
                    const active = categories.has(category);
                    return (
                        <button
                            key={category}
                            type="button"
                            onClick={() =>
                                setCategories(current => {
                                    const next = new Set(current);
                                    if (next.has(category)) {
                                        next.delete(category);
                                    } else {
                                        next.add(category);
                                    }
                                    return next;
                                })
                            }
                            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? 'border-accent/50 bg-accent/10 text-accent-soft' : 'border-line text-muted hover:bg-line'}`}
                        >
                            <Icon size={12} /> {tt(`activity.category.${category}`)}
                        </button>
                    );
                })}
                <Input className="ml-auto w-44" value={query} onChange={setQuery} placeholder={t('activity.search')} />
            </div>

            {/* journal */}
            {visible.length === 0 ? (
                <EmptyState title={t('activity.empty')} hint={t('activity.emptyHint')} icon={<IconActivity size={28} />} />
            ) : (
                <div className="overflow-hidden rounded-xl border border-line bg-surface/60">
                    {groups.map(([day, dayLogs]) => (
                        <div key={day}>
                            <div className="border-b border-line bg-canvas/40 px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">
                                {dayLabel(day)}
                            </div>
                            {dayLogs.map(log => {
                                const Icon = CATEGORY_ICONS[log.category ?? 'system'] ?? IconSettings;
                                const entry = log.entryId !== undefined ? library.find(candidate => candidate.id === log.entryId) : undefined;
                                const suggestion = log.code !== undefined && SUGGESTION_CODES.has(log.code) && entry?.migrationSuggestion ? entry : undefined;
                                return (
                                    <div
                                        key={log.id}
                                        className="flex items-start gap-3 border-b border-line/60 px-4 py-2.5 text-sm last:border-b-0 hover:bg-card/40"
                                    >
                                        <span className="mt-0.5 flex-none text-faint" title={tt(`activity.category.${log.category ?? 'system'}`)}>
                                            <Icon size={15} />
                                        </span>
                                        <div className="min-w-0 flex-1 break-words text-fg">
                                            {log.code ? tt(`activity.${log.code}`, log.params) : log.message}
                                            {entry && (
                                                <button
                                                    type="button"
                                                    onClick={() => onOpenSeries(entry.id)}
                                                    className="ml-1.5 rounded border border-line px-1.5 py-px text-[11px] text-muted transition-colors hover:border-accent/40 hover:text-accent-soft"
                                                >
                                                    {t('activity.openSeries')}
                                                </button>
                                            )}
                                            {suggestion && (
                                                <>
                                                    <button
                                                        type="button"
                                                        disabled={busy === suggestion.id}
                                                        onClick={() => answerSuggestion(suggestion.id, true)}
                                                        className="ml-1.5 rounded border border-accent/30 bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent-soft disabled:opacity-40"
                                                    >
                                                        {t('activity.suggestionConfirm')}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={busy === suggestion.id}
                                                        onClick={() => answerSuggestion(suggestion.id, false)}
                                                        className="ml-1 rounded border border-line px-1.5 py-px text-[11px] text-muted disabled:opacity-40"
                                                    >
                                                        {t('activity.suggestionDismiss')}
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                        <span className="flex-none">
                                            <Badge tone={log.level === 'error' ? 'red' : log.level === 'warn' ? 'orange' : 'zinc'}>
                                                {tt(`activity.level.${log.level}`)}
                                            </Badge>
                                        </span>
                                        <span className="flex-none text-xs text-faint">{timeOf(log.at)}</span>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}

            <div className="flex justify-center">
                <Button variant="ghost" onClick={loadMore} disabled={loadingMore}>
                    {t('activity.loadMore')}
                </Button>
            </div>
        </div>
    );
}
