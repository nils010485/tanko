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
import { IconAlert, IconCheck, IconChevronDown, IconUndo, IconX } from './icons.js';
import { useToast } from './toast.js';
import { Badge, Button, Spinner } from './ui.js';

/** Above this score the bulk button offers to migrate everything at once. */
const HIGH_SCORE = 0.9;
/** Above this score the match badge is green; below LOW_SCORE it is red. */
const GOOD_SCORE = 0.85;
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
    const confirmSuggestion = useCallback(
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
            const outcome: Outcome = apply ? 'migrated' : 'dismissed';
            const decided = { ...results, [entry.id]: outcome };
            if (await confirmSuggestion(entry, apply)) {
                setResults(decided);
                setIndex(nextPendingIndex(snapshot, decided, index));
                onChanged();
            }
            lock(null);
        },
        [snapshot, index, results, confirmSuggestion, lock, onChanged]
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
            if (!(await confirmSuggestion(entry, true, true))) {
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
            if (busyRef.current || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
                return;
            }
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            if (event.key === 'Enter') {
                // let a focused button (Migrer/Refuser/chip) handle its own
                // activation instead of diverting Enter to act(true)
                if (target?.closest('button') || target?.closest('a')) {
                    return;
                }
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
    }, [open, allDone, act, skip]);

    if (!open || snapshot.length === 0) {
        return null;
    }

    const suggestion = current?.migrationSuggestion;
    const suggestedChapters = suggestion?.chapterCount ?? 0;
    const gain = current ? suggestedChapters - current.chapterCount : 0;
    const score = suggestion?.score ?? 0;
    const titleDiffers = !!suggestion && suggestion.mangaTitle.toLowerCase() !== current.title.toLowerCase();
    const migratedEntries = snapshot.filter(entry => results[entry.id] === 'migrated');
    const dismissedEntries = snapshot.filter(entry => results[entry.id] === 'dismissed');
    const decidedCount = snapshot.length - remaining;
    const scoreClass = score >= GOOD_SCORE ? 'text-green-400' : score >= LOW_SCORE ? 'text-sky-400' : 'text-red-400';

    const summaryRow = (entry: LibraryEntryDto, outcome: Outcome) => (
        <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas/60 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2">
                {outcome === 'migrated' ? <IconCheck size={14} className="flex-none text-green-400" /> : <IconX size={14} className="flex-none text-faint" />}
                <span className={`truncate text-fg ${undoneIds.includes(entry.id) ? 'line-through opacity-60' : ''}`}>
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
                if (!busyRef.current && event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('library.migrationModalTitle')}
                className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl shadow-black/60"
            >
                <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
                    <div className="min-w-0">
                        <h2 className="font-bold leading-tight">{t('library.migrationModalTitle')}</h2>
                        {!allDone && (
                            <p className="mt-0.5 text-xs text-faint">
                                {t('library.migrationProgress', { index: Math.min(decidedCount + 1, snapshot.length), total: snapshot.length })}
                            </p>
                        )}
                    </div>
                    <button type="button" title={t('common.close')} onClick={onClose} className="flex-none p-1 text-faint transition-colors hover:text-fg">
                        <IconX size={16} />
                    </button>
                </div>
                {!allDone && (
                    <div className="mx-5 h-0.5 overflow-hidden rounded-full bg-line">
                        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(decidedCount / snapshot.length) * 100}%` }} />
                    </div>
                )}

                {allDone ? (
                    <div className="overflow-y-auto px-5 py-8 text-center">
                        <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full border border-green-500/30 bg-green-500/15 text-green-400">
                            <IconCheck size={22} />
                        </div>
                        <h3 className="font-bold">{t('library.migrationModalDone')}</h3>
                        <div className="mx-auto mt-4 max-w-md space-y-1.5 text-left">
                            {migratedEntries.map(entry => summaryRow(entry, 'migrated'))}
                            {dismissedEntries.map(entry => summaryRow(entry, 'dismissed'))}
                            <div className="pt-1 text-center text-xs text-faint">
                                {t('library.migrationSummary', {
                                    migrated: migratedEntries.length,
                                    dismissed: dismissedEntries.length
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
                            <div className="overflow-y-auto px-5 py-4">
                                <div className="flex gap-3">
                                    <Cover
                                        title={current.title}
                                        thumbnail={current.thumbnail}
                                        coverUrl={current.coverUrl}
                                        className="aspect-[2/3] w-14 flex-none rounded-lg border border-line sm:w-16"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <h3 className="truncate font-bold leading-tight" title={current.title}>
                                                {current.title}
                                            </h3>
                                            <span className={`flex-none text-xs font-semibold ${scoreClass}`} title={t('library.migrationMatchHint')}>
                                                {Math.round(score * 100)} %
                                            </span>
                                        </div>
                                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                                            <span>{current.sourceLabel ?? t('library.noSourceBadge')}</span>
                                            <span>· {t('library.chaptersRatio', { downloaded: current.downloadedCount, total: current.chapterCount })}</span>
                                            {(current.checkFailures ?? 0) > 0 && (
                                                <Badge tone="red" solid>
                                                    {t('library.failuresShort', { n: current.checkFailures ?? 0 })}
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-3 rounded-lg bg-canvas/70 px-3 py-2.5 text-sm">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate text-faint">
                                            {current.sourceLabel ?? t('library.noSourceBadge')}
                                            <span className="text-[11px]"> · {t('library.migrationCurrentSuffix')}</span>
                                        </span>
                                        <span className="flex-none tabular-nums text-muted">{t('library.migrationChapters', { n: current.chapterCount })}</span>
                                    </div>
                                    <div className="flex justify-center py-0.5 text-faint">
                                        <IconChevronDown size={14} />
                                    </div>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate font-medium text-accent-soft">{suggestion.sourceLabel}</span>
                                        <span className="flex-none font-medium tabular-nums">
                                            {t('library.migrationChapters', { n: suggestedChapters })}
                                            {gain > 0 && <span className="text-xs font-semibold text-green-400"> +{gain}</span>}
                                        </span>
                                    </div>
                                    {(titleDiffers || score < LOW_SCORE) && (
                                        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-300/90">
                                            <IconAlert size={13} className="mt-0.5 flex-none" />
                                            <span>
                                                {titleDiffers && `${t('library.migrationWarnTitle', { title: suggestion.mangaTitle })} `}
                                                {score < LOW_SCORE && t('library.migrationWarnLow')}
                                            </span>
                                        </div>
                                    )}
                                </div>

                                <p className="mt-2 text-[11px] text-faint">{t('library.migrationKeepHint')}</p>
                            </div>

                            <div className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:flex-row sm:items-center">
                                {bulkCount >= 2 && (
                                    <button
                                        type="button"
                                        disabled={!!busy}
                                        onClick={bulkMigrate}
                                        title={t('library.migrationQuickHint', { n: bulkCount, pct: Math.round(HIGH_SCORE * 100) })}
                                        className="order-last flex items-center justify-center gap-1.5 text-xs text-faint transition-colors hover:text-muted disabled:cursor-wait disabled:opacity-60 sm:order-none sm:justify-start"
                                    >
                                        {busy === 'bulk' ? (
                                            <>
                                                <Spinner size={12} /> {t('library.migrationQuickBusy')}
                                            </>
                                        ) : (
                                            t('library.migrationQuick', { n: bulkCount })
                                        )}
                                    </button>
                                )}
                                <div className="order-2 flex gap-2 sm:order-none sm:ml-auto">
                                    <Button small variant="ghost" disabled={!!busy || remaining <= 1} onClick={skip} className="flex-1 sm:flex-none">
                                        {t('library.migrationLater')}
                                    </Button>
                                    <Button
                                        small
                                        variant="danger"
                                        disabled={!!busy}
                                        loading={busy === 'act'}
                                        onClick={() => act(false)}
                                        className="flex-1 sm:flex-none"
                                    >
                                        <IconX size={12} /> {t('library.migrationDismiss')}
                                    </Button>
                                </div>
                                <Button
                                    small
                                    autoFocus
                                    disabled={!!busy}
                                    loading={busy === 'act'}
                                    onClick={() => act(true)}
                                    className="order-1 w-full sm:order-none sm:w-auto"
                                >
                                    {t('library.migrate')} →
                                </Button>
                            </div>
                        </>
                    )
                )}
            </div>
        </div>
    );
}
