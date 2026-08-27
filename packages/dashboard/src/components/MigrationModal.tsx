/**
 * Queue modal to process pending source migrations quickly: one suggestion at
 * a time with a current-vs-suggested chapter comparison, a bulk apply for
 * high-confidence matches, keyboard shortcuts and an undo-capable summary.
 *
 * The pending entries are snapshotted on open so the queue stays stable even
 * while the parent refreshes the library after each applied action.
 */
import type { LibraryEntryDto } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.js';
import { api } from '../lib/api.js';
import { useEscapeKey } from '../lib/hooks.js';
import { Cover } from './Cover.js';
import { IconAlert, IconArrowLeftRight, IconCheck, IconUndo, IconX } from './icons.js';
import { useToast } from './toast.js';
import { Badge, Button, ProgressBar } from './ui.js';

/** Above this score the bulk button offers to migrate everything at once. */
const HIGH_SCORE = 0.9;
/** Below this score the card shows a warning before migrating. */
const LOW_SCORE = 0.8;

type Outcome = 'migrated' | 'dismissed';
type Busy = 'act' | 'bulk' | 'undo' | null;

/** Index of the first undecided entry after `from` (wrapping), or `from`. */
function nextPendingIndex(entries: LibraryEntryDto[], decided: Record<number, Outcome>, from: number): number {
    for (let step = 1; step <= entries.length; step++) {
        const candidate = (from + step) % entries.length;
        if (!decided[entries[candidate].id]) {
            return candidate;
        }
    }
    return from;
}

export function MigrationModal({
    open,
    entries,
    onClose,
    onChanged
}: {
    open: boolean;
    /** Library entries that currently carry a migrationSuggestion. */
    entries: LibraryEntryDto[];
    onClose: () => void;
    /** Ask the parent to refresh its library data (after applied actions). */
    onChanged: () => void;
}) {
    const { t } = useI18n();
    const toast = useToast();

    const [snapshot, setSnapshot] = useState<LibraryEntryDto[]>([]);
    const [results, setResults] = useState<Record<number, Outcome>>({});
    const [undoneIds, setUndoneIds] = useState<number[]>([]);
    const [index, setIndex] = useState(0);
    const [busy, setBusy] = useState<Busy>(null);

    // snapshot the queue when the modal opens (not on every entries change,
    // which would wipe the review progress once the parent refreshes)
    const entriesRef = useRef(entries);
    entriesRef.current = entries;
    useEffect(() => {
        if (!open) {
            return;
        }
        setSnapshot(entriesRef.current.filter(entry => entry.migrationSuggestion));
        setResults({});
        setUndoneIds([]);
        setIndex(0);
        busyRef.current = null;
        setBusy(null);
    }, [open]);

    const remaining = snapshot.filter(entry => !results[entry.id]).length;
    const allDone = snapshot.length > 0 && remaining === 0;
    const current = snapshot[index];
    const bulkCount = snapshot.filter(entry => !results[entry.id] && (entry.migrationSuggestion?.score ?? 0) >= HIGH_SCORE).length;
    // synchronous mirror of `busy`: a held Enter key fires repeat keydown
    // events before the re-render flips the state guard
    const busyRef = useRef<Busy>(null);
    const lock = useCallback((value: Busy) => {
        busyRef.current = value;
        setBusy(value);
    }, []);

    /** Confirm or dismiss one suggestion; returns whether it was applied. */
    const confirm = useCallback(
        async (entry: LibraryEntryDto, apply: boolean, silent = false): Promise<boolean> => {
            try {
                const result = await api.confirmRematch(entry.id, apply);
                if (!silent) {
                    if (apply) {
                        toast.success(t('library.migratedKept', { title: entry.title, kept: result.kept ?? 0, total: result.total ?? 0 }));
                    } else {
                        toast.info(t('library.migrationDismissed', { title: entry.title }));
                    }
                }
                return true;
            } catch (error) {
                toast.error((error as Error).message);
                return false;
            }
        },
        [t, toast]
    );

    const act = useCallback(
        async (apply: boolean) => {
            const entry = snapshot[index];
            if (!entry || results[entry.id] || busyRef.current) {
                return;
            }
            lock('act');
            const decided = { ...results, [entry.id]: apply ? ('migrated' as const) : ('dismissed' as const) };
            if (await confirm(entry, apply)) {
                setResults(decided);
                setIndex(nextPendingIndex(snapshot, decided, index));
                onChanged();
            }
            lock(null);
        },
        [snapshot, index, results, confirm, lock, onChanged]
    );

    const skip = useCallback(() => {
        if (busyRef.current) {
            return;
        }
        setIndex(current => nextPendingIndex(snapshot, results, current));
    }, [snapshot, results]);

    /** Migrate every pending high-score suggestion, stopping at the first failure. */
    const bulkMigrate = async () => {
        if (busyRef.current) {
            return;
        }
        lock('bulk');
        const decided = { ...results };
        let applied = 0;
        for (const entry of snapshot) {
            if (decided[entry.id] || (entry.migrationSuggestion?.score ?? 0) < HIGH_SCORE) {
                continue;
            }
            if (!(await confirm(entry, true, true))) {
                break;
            }
            decided[entry.id] = 'migrated';
            applied++;
        }
        if (applied > 0) {
            toast.success(t('library.migrationAutoApplied', { n: applied, pct: Math.round(HIGH_SCORE * 100) }));
            setResults(decided);
            setIndex(nextPendingIndex(snapshot, decided, index));
            onChanged();
        }
        lock(null);
    };

    const undo = async (entry: LibraryEntryDto) => {
        if (busyRef.current) {
            return;
        }
        lock('undo');
        try {
            await api.rollbackMigration(entry.id);
            toast.success(t('library.migrationUndone', { title: entry.title }));
            setUndoneIds(current => [...current, entry.id]);
            onChanged();
        } catch (error) {
            toast.error((error as Error).message);
        }
        lock(null);
    };

    useEscapeKey(onClose, open && !busy);

    // keyboard triage: Enter migrates, X dismisses, P/→ skips to the next one
    useEffect(() => {
        if (!open || allDone) {
            return undefined;
        }
        const onKey = (event: KeyboardEvent) => {
            if (busy || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                act(true);
            } else if (event.key.toLowerCase() === 'x') {
                event.preventDefault();
                act(false);
            } else if (event.key.toLowerCase() === 'p' || event.key === 'ArrowRight') {
                event.preventDefault();
                skip();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, allDone, busy, act, skip]);

    if (!open || snapshot.length === 0) {
        return null;
    }

    const suggestion = current?.migrationSuggestion;
    const suggestedChapters = suggestion?.chapterCount ?? 0;
    const gain = current ? suggestedChapters - current.chapterCount : 0;
    const score = suggestion?.score ?? 0;
    const matchTone = score >= 0.85 ? 'green' : score >= LOW_SCORE ? 'blue' : 'red';
    const titleDiffers = !!suggestion && suggestion.mangaTitle.toLowerCase() !== current.title.toLowerCase();

    const kbd = (key: string, label: string) => (
        <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 text-[10px] text-zinc-400">{key}</kbd>
            {label}
        </span>
    );

    const chip = (entry: LibraryEntryDto, position: number) => {
        const outcome = results[entry.id];
        const active = position === index;
        const className =
            outcome === 'migrated'
                ? 'border-green-500/40 bg-green-500/10 text-green-400'
                : outcome === 'dismissed'
                  ? 'border-zinc-700 bg-zinc-800/50 text-faint line-through'
                  : active
                    ? 'border-accent/60 bg-accent/10 font-medium text-accent-soft'
                    : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800';
        return (
            <button
                key={entry.id}
                type="button"
                disabled={!!busy}
                onClick={() => setIndex(position)}
                title={entry.title}
                className={`max-w-45 shrink-0 truncate rounded-md border px-2.5 py-1 text-xs transition-colors ${className}`}
            >
                {entry.title}
                {outcome === 'migrated' && ' ✓'}
                {outcome === 'dismissed' && ' ✕'}
            </button>
        );
    };

    const summaryRow = (entry: LibraryEntryDto, outcome: Outcome) => (
        <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas/60 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
                {outcome === 'migrated' ? (
                    <IconCheck size={14} className="flex-none text-green-400" />
                ) : (
                    <IconX size={14} className="flex-none text-zinc-500" />
                )}
                <span className={`truncate text-zinc-300 ${undoneIds.includes(entry.id) ? 'line-through opacity-60' : ''}`}>
                    {entry.title}
                    {outcome === 'migrated' && entry.migrationSuggestion ? ` → ${entry.migrationSuggestion.sourceLabel}` : ''}
                </span>
            </span>
            {outcome === 'migrated' && !undoneIds.includes(entry.id) && (
                <Button small variant="ghost" disabled={!!busy} onClick={() => undo(entry)}>
                    <IconUndo size={12} /> {t('library.migrationUndo')}
                </Button>
            )}
        </div>
    );

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click-outside backdrop; the dialog also closes with Escape (useEscapeKey above)
        <div
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
            onClick={event => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('library.migrationModalTitle')}
                className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-surface shadow-2xl shadow-black/60"
            >
                <div className="flex items-start justify-between gap-3 border-b border-line px-5 pb-3 pt-4">
                    <div className="flex items-center gap-3">
                        <div className="grid h-9 w-9 flex-none place-items-center rounded-lg border border-accent/30 bg-accent/15 text-accent-soft">
                            <IconArrowLeftRight size={16} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="font-bold leading-tight">{t('library.migrationModalTitle')}</h2>
                                <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${remaining > 0 ? 'bg-accent text-zinc-950' : 'bg-zinc-700 text-zinc-300'}`}
                                >
                                    {remaining}
                                </span>
                            </div>
                            <p className="mt-0.5 text-xs text-faint">{t('library.migrationModalHint')}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {bulkCount >= 2 && !allDone && (
                            <button
                                type="button"
                                disabled={!!busy}
                                onClick={bulkMigrate}
                                title={t('library.migrateAllHint')}
                                className="rounded-md border border-green-500/40 bg-green-500/10 px-2 py-1 text-[11px] font-semibold text-green-400 transition-colors hover:bg-green-500/20 disabled:opacity-50"
                            >
                                {t('library.migrateAll', { n: bulkCount, pct: Math.round(HIGH_SCORE * 100) })}
                            </button>
                        )}
                        <button type="button" title={t('common.close')} onClick={onClose} className="p-1 text-zinc-500 transition-colors hover:text-zinc-200">
                            <IconX size={16} />
                        </button>
                    </div>
                </div>

                {allDone ? (
                    <div className="px-5 py-8 text-center">
                        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full border border-green-500/30 bg-green-500/15 text-green-400">
                            <IconCheck size={22} />
                        </div>
                        <h3 className="font-bold">{t('library.migrationModalDone')}</h3>
                        <div className="mx-auto mt-4 max-w-md space-y-1.5 text-left">
                            {snapshot.filter(entry => results[entry.id] === 'migrated').map(entry => summaryRow(entry, 'migrated'))}
                            {snapshot.filter(entry => results[entry.id] === 'dismissed').map(entry => summaryRow(entry, 'dismissed'))}
                            <div className="pt-1 text-center text-xs text-faint">
                                {t('library.migrationSummary', {
                                    migrated: Object.values(results).filter(outcome => outcome === 'migrated').length,
                                    dismissed: Object.values(results).filter(outcome => outcome === 'dismissed').length
                                })}
                            </div>
                        </div>
                        <div className="mt-6">
                            <Button onClick={onClose}>{t('common.close')}</Button>
                        </div>
                    </div>
                ) : (
                    current &&
                    suggestion && (
                        <>
                            <div className="flex gap-1.5 overflow-x-auto border-b border-line px-5 py-2.5">{snapshot.map(chip)}</div>

                            <div className="flex gap-4 px-5 py-4">
                                <Cover
                                    title={current.title}
                                    thumbnail={current.thumbnail}
                                    coverUrl={current.coverUrl}
                                    className="aspect-[2/3] w-20 flex-none rounded-lg border border-line"
                                />
                                <div className="min-w-0 flex-1 space-y-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <h3 className="truncate font-bold leading-tight" title={current.title}>
                                                {current.title}
                                            </h3>
                                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                                {current.sourceLabel ? (
                                                    <Badge>{current.sourceLabel}</Badge>
                                                ) : (
                                                    <Badge tone="red">{t('library.noSourceBadge')}</Badge>
                                                )}
                                                {(current.checkFailures ?? 0) > 0 && (
                                                    <Badge tone="red" solid>
                                                        {t('library.failuresShort', { n: current.checkFailures ?? 0 })}
                                                    </Badge>
                                                )}
                                                <span className="text-[11px] text-faint">
                                                    {t('library.chaptersRatio', { downloaded: current.downloadedCount, total: current.chapterCount })}
                                                </span>
                                            </div>
                                        </div>
                                        <span title={t('library.migrationMatchHint')}>
                                            <Badge tone={matchTone}>{t('library.migrationMatch', { pct: Math.round(score * 100) })}</Badge>
                                        </span>
                                    </div>

                                    <div className="space-y-2.5 rounded-xl border border-line bg-canvas/60 p-3">
                                        <div>
                                            <div className="mb-1 flex justify-between text-xs">
                                                <span className="text-faint">{t('library.migrationCurrentSource')}</span>
                                                <span className="text-zinc-400">{t('library.migrationChapters', { n: current.chapterCount })}</span>
                                            </div>
                                            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                                                <div
                                                    className="h-full rounded-full bg-zinc-600"
                                                    style={{ width: `${Math.min(100, (current.chapterCount / Math.max(suggestedChapters, 1)) * 100)}%` }}
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <div className="mb-1 flex justify-between text-xs">
                                                <span className="text-accent-soft">
                                                    {t('library.migrationSuggestionSource', { source: suggestion.sourceLabel })}
                                                </span>
                                                <span className="font-medium text-zinc-200">
                                                    {t('library.migrationChapters', { n: suggestedChapters })}
                                                    {gain > 0 && <span className="text-green-400"> +{gain}</span>}
                                                </span>
                                            </div>
                                            <ProgressBar value={100} tone="orange" />
                                        </div>
                                        {(titleDiffers || score < LOW_SCORE) && (
                                            <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300/90">
                                                <IconAlert size={13} className="mt-0.5 flex-none" />
                                                <span>
                                                    {titleDiffers && `${t('library.migrationWarnTitle', { title: suggestion.mangaTitle })} `}
                                                    {score < LOW_SCORE && t('library.migrationWarnLow')}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    <p className="text-[11px] text-faint">{t('library.migrationKeepHint')}</p>
                                </div>
                            </div>

                            <div className="flex items-center justify-between gap-3 border-t border-line bg-canvas/40 px-5 py-3.5">
                                <div className="hidden items-center gap-3 text-[11px] text-faint sm:flex">
                                    {kbd('↵', t('library.migrate'))}
                                    {kbd('X', t('library.migrationDismiss'))}
                                    {kbd('P', t('library.migrationLater'))}
                                </div>
                                <div className="ml-auto flex items-center gap-2">
                                    <Button small variant="ghost" disabled={!!busy || remaining <= 1} onClick={skip}>
                                        {t('library.migrationLater')}
                                    </Button>
                                    <Button small variant="danger" disabled={!!busy} loading={busy === 'act'} onClick={() => act(false)}>
                                        <IconX size={12} /> {t('library.migrationDismiss')}
                                    </Button>
                                    <Button small disabled={!!busy} loading={busy === 'act'} onClick={() => act(true)} autoFocus>
                                        {t('library.migrate')} →
                                    </Button>
                                </div>
                            </div>
                        </>
                    )
                )}
            </div>
        </div>
    );
}
