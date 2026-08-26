/**
 * Scheduler: periodically checks every library entry for new chapters.
 * New chapters are flagged in the library and (optionally) auto-enqueued
 * into the download queue. Status is published on the WebSocket bus.
 */

import type { LibraryEntryDto, ScheduleStatusDto } from '@tanko/shared';
import { Cron } from 'croner';
import type { Database } from '../db.js';
import type { DownloadQueue } from '../downloader/queue.js';
import { DOWNLOAD_FAILOVER_FAILURES, INCOMPLETE_SOURCE_CHAPTERS, OUTAGE_SILENCE_MS, SOURCE_OUTAGE_ENTRIES } from '../library/failover.js';
import { type NotificationSettings, sendNotification } from '../library/notify.js';
import type { ChapterRow, LibraryStore } from '../library/store.js';
import type { EventBus } from '../ws.js';

const SETTINGS_KEY = 'schedule';
const LAST_RUN_KEY = 'schedule.lastrun';
/** Delay before re-checking the entries that failed a run (transient errors
 *  self-heal within minutes; real outages arm the failover in ~30min instead
 *  of ~18h at cron 6h × 3 failures). */
const RETRY_DELAY_MS = 12 * 60 * 1000;
/** Max starved-source probes per scheduler run (see _detectIncompleteSources). */
const DETECTION_PROBES = 10;
/** Retry rounds after a run: t0 + 12min + 24min reaches the 3-failure threshold. */
const MAX_RETRY_ROUNDS = 2;
/** Raised when the source still answers but lists zero chapters in the
 *  preferred languages (license takedown typically) — a per-series CONTENT
 *  signal: it must keep migrating at its own pace, never open an outage. */
const NO_USABLE_CHAPTERS = 'la source ne référence plus aucun chapitre dans les langues préférées';
/** A series with no new chapter for this long is hidden (autoUnfollow). 120
 *  days: monthly series publish every ~30 days, quarterly ones every ~92. */
const UNFOLLOW_STALE_DAYS = 120;
export interface ScheduleSettings {
    enabled: boolean;
    cron: string;
    autoDownload: boolean;
    autoUnfollow: boolean;
    notifications: NotificationSettings;
}

const DEFAULTS: ScheduleSettings = {
    enabled: true,
    cron: '0 */6 * * *',
    autoDownload: true,
    autoUnfollow: false,
    notifications: { enabled: false, webhookUrl: '' }
};

export class Scheduler {
    private job: Cron | undefined;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;
    private settings: ScheduleSettings;
    private running = false;
    private lastRunAt?: string;
    private lastRunResult?: string;
    private seriesChecked = 0;
    private newChaptersFound = 0;
    /** A starved-source detection pass is in flight (prevents overlapping passes). */
    private detectPassRunning = false;

    constructor(
        private readonly opts: {
            db: Database;
            store: LibraryStore;
            queue: DownloadQueue;
            events: EventBus;
            /** Optional source failover: invoked after repeated check failures. */
            failover?: {
                maybeMigrate(entry: { id: number; sourceId: string; title: string }, auto?: boolean): Promise<'migrated' | 'suggested' | 'none'>;
                /** Shared probe guard: false when a probe already crawls for the entry. */
                tryBeginProbe(entryId: number): boolean;
                endProbe(entryId: number): void;
                /** Opt-in starved-source detection (Settings toggle). */
                suggestIfIncomplete?(entry: { id: number; sourceId: string; title: string }, chapterCount: number): Promise<boolean>;
            };
        }
    ) {
        this.settings = this._load();
        this._loadLastRun();
        this._startJob();
    }

    // ------------------------------------------------------------------
    // settings
    // ------------------------------------------------------------------

    getSettings(): ScheduleSettings {
        return { ...this.settings, notifications: { ...this.settings.notifications } };
    }

    updateSettings(patch: Partial<Omit<ScheduleSettings, 'notifications'>> & { notifications?: Partial<NotificationSettings> }): ScheduleSettings {
        this.settings = {
            ...this.settings,
            ...patch,
            notifications: { ...this.settings.notifications, ...(patch.notifications || {}) }
        };
        // patch values can arrive untyped from HTTP clients: keep `enabled` a real boolean
        if (typeof this.settings.enabled !== 'boolean') {
            this.settings.enabled = true;
        }
        // same for the auto-unfollow toggle
        if (typeof this.settings.autoUnfollow !== 'boolean') {
            this.settings.autoUnfollow = false;
        }
        this.opts.db.kvSet(SETTINGS_KEY, JSON.stringify(this.settings));
        this._startJob();
        this._publishStatus();
        return this.getSettings();
    }

    // ------------------------------------------------------------------
    // runs
    // ------------------------------------------------------------------

    async runNow(): Promise<{ checked: number; newChapters: number; alreadyRunning?: boolean }> {
        if (this.running) {
            // distinguishable from a real empty run (API clients, logs)
            return { checked: 0, newChapters: 0, alreadyRunning: true };
        }
        this.running = true;
        const startedAt = Date.now();
        let checked = 0;
        let totalNew = 0;
        const newBySeries: Array<{ title: string; chapters: string[] }> = [];
        // entries already failover-probed in this run (the check-failure and
        // download-failure loops can both target the same entry — probing it
        // once is enough and halves the catalog crawls)
        const failoverProbed = new Set<number>();
        const failedIds = new Set<number>();
        try {
            const entries = await this.opts.store.listEntries();
            for (const entry of entries) {
                const fresh = await this._checkOne(entry, failoverProbed, failedIds);
                checked++;
                totalNew += fresh.length;
                if (fresh.length > 0) {
                    newBySeries.push({ title: entry.title, chapters: fresh.map(chapter => chapter.title) });
                }
            }
            // outage maintenance, before the backstop: close outages whose
            // last observed failure is stale (the source quietly recovered —
            // restart the failed jobs' retry ladder) and arm the escalation
            // of outages whose jobs stopped retrying before OUTAGE_ESCALATION_MS
            for (const outage of this.opts.store.listSourceOutages()) {
                if (Date.parse(outage.lastSeenAt) + OUTAGE_SILENCE_MS < Date.now()) {
                    // deep backoff slots (up to 4 h) produce no failure events:
                    // only close by silence once the source has nothing left to retry
                    if (this.opts.queue.hasActiveJobs(outage.sourceId)) {
                        continue;
                    }
                    this.opts.store.closeSourceOutage(outage.sourceId);
                    this.opts.queue.resetRetryLadder(outage.sourceId);
                    this.opts.events.publish({
                        type: 'log',
                        level: 'info',
                        message: `La source ${outage.sourceId} n'échoue plus — clôture de la panne, reprise des téléchargements en échec`,
                        at: new Date().toISOString()
                    });
                    continue;
                }
                const escalated = this.opts.store.armOutageEscalation(outage.sourceId);
                if (escalated?.escalatedAt && !outage.escalatedAt) {
                    this.opts.events.publish({
                        type: 'log',
                        level: 'warn',
                        message: `Panne de la source ${outage.sourceId} persistante — migration de source réautorisée`,
                        at: new Date().toISOString()
                    });
                }
            }
            // backstop for download failures that did not trip the immediate
            // probe (index.ts): same threshold, on the scheduler cadence
            if (this.opts.failover) {
                for (const entry of this.opts.store.listDownloadFailing(DOWNLOAD_FAILOVER_FAILURES)) {
                    if (failoverProbed.has(entry.id) || this.opts.queue.hasPendingJobs(entry.id)) {
                        continue; // already probed in this run, or the immediate probe owns it once the running jobs settle
                    }
                    // source-wide outage: migration stays suspended until it is
                    // escalated (persistent) — otherwise the queue's auto-retry
                    // heals the failed jobs when the source comes back
                    const outage = this.opts.store.getSourceOutage(entry.sourceId);
                    if (outage && !outage.escalatedAt) {
                        continue;
                    }
                    failoverProbed.add(entry.id);
                    if (!this.opts.failover.tryBeginProbe(entry.id)) {
                        continue; // an immediate probe is already crawling for this entry
                    }
                    try {
                        const outcome = await this.opts.failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                        this.opts.events.publish({
                            type: 'log',
                            level: outcome === 'migrated' ? 'info' : 'warn',
                            message: `${this._failoverMessage(entry.title, outcome)} (${entry.downloadFailures} téléchargements en échec)`,
                            at: new Date().toISOString()
                        });
                        if (outcome === 'migrated') {
                            this.opts.store.requeueFailedAfterMigration(entry.id, this.opts.queue);
                        }
                    } catch (error) {
                        console.warn(`[failover] "${entry.title}":`, (error as Error).message);
                    } finally {
                        // implicit backoff: the probe only re-arms after as
                        // many fresh download failures (DOWNLOAD_FAILOVER_FAILURES)
                        this.opts.store.resetDownloadFailures(entry.id);
                        this.opts.failover.endProbe(entry.id);
                    }
                }
            }

            const hiddenStale = this._hideStaleEntries();
            this.lastRunResult = `checked ${checked} series, ${totalNew} new chapter(s)${hiddenStale > 0 ? `, ${hiddenStale} stale series hidden` : ''} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
            this._detectIncompleteSources(); // background, opt-in
            if (totalNew > 0) {
                await this._notifyNewChapters(newBySeries);
            }
        } catch (error) {
            this.lastRunResult = `failed: ${(error as Error).message}`;
        } finally {
            this.running = false;
            this.lastRunAt = new Date().toISOString();
            this.seriesChecked = checked;
            this.newChaptersFound = totalNew;
            this._saveLastRun();
            this._publishStatus();
            this._scheduleRetry(failedIds, 0);
        }
        return { checked, newChapters: totalNew };
    }

    /** Opt-in pass run after each check run: series whose last new chapter is
     *  older than UNFOLLOW_STALE_DAYS are hidden (reversible from « Masquées »;
     *  files and history are kept, the scheduler ignores hidden entries).
     *  Entries with pending check failures are skipped by the store — an
     *  unreachable source is not an abandoned series. */
    private _hideStaleEntries(): number {
        if (!this.settings.autoUnfollow) {
            return 0;
        }
        let hidden = 0;
        for (const stale of this.opts.store.listStaleEntries(UNFOLLOW_STALE_DAYS)) {
            this.opts.store.setHidden(stale.id, true);
            hidden++;
            this.opts.events.publish({
                type: 'log',
                level: 'info',
                message: `"${stale.title}" masquée automatiquement (aucun nouveau chapitre depuis plus de ${UNFOLLOW_STALE_DAYS} jours)`,
                at: new Date().toISOString()
            });
            const updated = this.opts.store.getEntry(stale.id);
            if (updated) {
                this.opts.events.publish({ type: 'library.updated', entry: updated });
            }
        }
        return hidden;
    }

    /** Background pass after each run (opt-in): starved sources — entries with
     *  very few chapters — get searched on the other sources; a much richer
     *  alternative is surfaced as a migration suggestion. Bounded to
     * DETECTION_PROBES entries per run to keep the source load sane. */
    private _detectIncompleteSources(): void {
        if (!this.opts.failover?.suggestIfIncomplete || this.detectPassRunning) {
            return;
        }
        this.detectPassRunning = true;
        let probes = 0;
        void (async () => {
            try {
                for (const entry of await this.opts.store.listEntries()) {
                    if (probes >= DETECTION_PROBES) {
                        break;
                    }
                    if (entry.hidden || entry.migrationSuggestion || entry.chapterCount > INCOMPLETE_SOURCE_CHAPTERS) {
                        continue;
                    }
                    probes++;
                    try {
                        // member call on purpose: suggestIfIncomplete relies on `this`
                        const suggested = await this.opts.failover?.suggestIfIncomplete?.(
                            { id: entry.id, sourceId: entry.sourceId, title: entry.title },
                            entry.chapterCount
                        );
                        if (suggested) {
                            const updated = this.opts.store.getEntry(entry.id);
                            if (updated) {
                                this.opts.events.publish({ type: 'library.updated', entry: updated });
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, 250));
                    } catch {
                        /* next entry */
                    }
                }
            } catch {
                /* the pass is best-effort background work */
            } finally {
                this.detectPassRunning = false;
            }
        })();
    }

    status(): ScheduleStatusDto {
        const next = this.job?.nextRun();
        return {
            enabled: this.settings.enabled,
            cron: this.settings.cron,
            nextRunAt: next ? next.toISOString() : undefined,
            lastRunAt: this.lastRunAt,
            lastRunResult: this.lastRunResult,
            seriesChecked: this.seriesChecked,
            newChaptersFound: this.newChaptersFound
        };
    }

    stop(): void {
        this.job?.stop();
        this.job = undefined;
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /** Check one entry for new chapters; logs, auto-enqueues and returns the fresh chapters. */
    private async _checkEntry(entry: LibraryEntryDto, failoverProbed: Set<number>, failedIds?: Set<number>): Promise<ChapterRow[]> {
        const { fresh, usableSeen } = await this.opts.store.checkForNewChapters(entry.id);
        if (usableSeen === 0 && (entry.downloadedCount > 0 || entry.autoDownload)) {
            // La source ne référence plus aucun chapitre dans les langues préférées
            // (retrait pour licence typiquement) alors que la série est suivie —
            // déjà téléchargée ou en attente de nouveautés : compter comme un échec
            // pour armer le failover au lieu de rester silencieusement à « 0 nouveau ».
            await this._handleCheckFailure(entry, new Error(NO_USABLE_CHAPTERS), failoverProbed, failedIds);
            return [];
        }
        this.opts.store.resetCheckFailures(entry.id);
        if (fresh.length > 0) {
            this.opts.events.publish({
                type: 'log',
                level: 'info',
                message: `${entry.title}: ${fresh.length} new chapter(s) on ${entry.sourceLabel}`,
                at: new Date().toISOString()
            });
            if (this.settings.autoDownload && entry.autoDownload) {
                this.opts.store.enqueueChapters(
                    entry.id,
                    fresh.map(chapter => chapter.chapter_id),
                    this.opts.queue
                );
            }
        }
        this._publishEntryUpdated(entry.id);
        return fresh;
    }

    /** Jitter + check one entry; failures are routed to _handleCheckFailure and reported as []. */
    private async _checkOne(entry: LibraryEntryDto, failoverProbed: Set<number>, failedIds: Set<number>): Promise<ChapterRow[]> {
        await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 1200));
        try {
            return await this._checkEntry(entry, failoverProbed, failedIds);
        } catch (error) {
            await this._handleCheckFailure(entry, error, failoverProbed, failedIds);
            return [];
        }
    }

    /** A series check failed: log it, count the failure, and try a failover after repeated failures. */
    private async _handleCheckFailure(entry: LibraryEntryDto, error: unknown, failoverProbed?: Set<number>, failedIds?: Set<number>): Promise<void> {
        failedIds?.add(entry.id);
        this.opts.events.publish({
            type: 'log',
            level: 'warn',
            message: `Check failed for "${entry.title}" (${entry.sourceLabel}): ${(error as Error).message}`,
            at: new Date().toISOString()
        });
        // repeated failures -> the source is probably dead for this series: try a failover
        const failures = this.opts.store.recordCheckFailure(entry.id);
        // a source-wide outage suspends migration on this path too (same
        // policy as the download path — probes resume once it escalates).
        // Only thrown errors (network, API) may OPEN the outage: a listing
        // that succeeds with zero usable chapters is a per-series takedown
        // and keeps migrating at its own 3-strike pace, outage or not
        const open = (error as Error).message !== NO_USABLE_CHAPTERS && this.opts.store.countEntriesWithCheckFailures(entry.sourceId) >= SOURCE_OUTAGE_ENTRIES;
        const outage = this.opts.store.noteSourceFailure(entry.sourceId, open);
        if (outage && !outage.escalatedAt) {
            return;
        }

        // attempt at the 3rd failure, then sparsely (every 20th): probing the
        // alternative sources is slow, it must not dominate every scheduled run
        if (failures < 3 || (failures !== 3 && failures % 20 !== 0) || !this.opts.failover) {
            return;
        }
        if (failoverProbed?.has(entry.id)) {
            return; // already probed in this run (download-failure loop)
        }
        failoverProbed?.add(entry.id);
        if (!this.opts.failover.tryBeginProbe(entry.id)) {
            return; // an immediate or backstop probe already crawls for this entry
        }
        try {
            const outcome = await this.opts.failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            this.opts.events.publish({
                type: 'log',
                level: outcome === 'migrated' ? 'info' : 'warn',
                message: this._failoverMessage(entry.title, outcome),
                at: new Date().toISOString()
            });
            if (outcome === 'migrated') {
                this.opts.store.requeueFailedAfterMigration(entry.id, this.opts.queue);
            }
            this._publishEntryUpdated(entry.id);
        } catch (migrationError) {
            console.warn(`[failover] "${entry.title}":`, (migrationError as Error).message);
        } finally {
            this.opts.failover.endProbe(entry.id);
        }
    }

    /** Schedule a one-off re-check of the entries that just failed (see RETRY_DELAY_MS). */
    private _scheduleRetry(failedIds: Set<number>, round: number): void {
        if (failedIds.size === 0 || round >= MAX_RETRY_ROUNDS || !this.settings.enabled) {
            return;
        }
        // a pending retry from a previous run is superseded by the fresh id set
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this._retryFailed(failedIds, round).catch(error => console.warn('[scheduler] retry run failed:', error));
        }, RETRY_DELAY_MS);
    }

    /** Re-check only the given entries; entries still failing arm the next round. */
    private async _retryFailed(entryIds: Set<number>, round: number): Promise<void> {
        if (this.running) {
            return; // a full run owns the schedule; its own failures re-arm a retry
        }
        this.running = true;
        const failoverProbed = new Set<number>();
        const stillFailing = new Set<number>();
        try {
            for (const id of entryIds) {
                const entry = this.opts.store.getEntry(id);
                if (!entry || entry.hidden) {
                    continue; // removed or hidden since the failure
                }
                await this._checkOne(entry, failoverProbed, stillFailing);
            }
        } finally {
            this.running = false;
            this._publishStatus();
        }
        this._scheduleRetry(stillFailing, round + 1);
    }

    /** Log message for a failover outcome. */
    private _failoverMessage(title: string, outcome: 'migrated' | 'suggested' | 'none'): string {
        switch (outcome) {
            case 'migrated':
                return `"${title}" migré automatiquement vers une autre source`;
            case 'suggested':
                return `"${title}" : migration de source suggérée (à confirmer)`;
            default:
                return `"${title}" : aucune source de rechange trouvée`;
        }
    }

    /** Push the current state of a library entry to the dashboard. */
    private _publishEntryUpdated(entryId: number): void {
        const entry = this.opts.store.getEntry(entryId);
        if (entry) {
            this.opts.events.publish({ type: 'library.updated', entry });
        }
    }

    /** Send the new-chapters webhook notification. */
    private async _notifyNewChapters(newBySeries: Array<{ title: string; chapters: string[] }>): Promise<void> {
        const body = newBySeries.map(item => `• ${item.title}: ${item.chapters.slice(0, 5).join(', ')}${item.chapters.length > 5 ? '…' : ''}`).join('\n');
        await sendNotification(this.settings.notifications, 'New chapters available', body);
    }

    private _load(): ScheduleSettings {
        try {
            const raw = this.opts.db.kvGet(SETTINGS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return {
                    ...DEFAULTS,
                    ...parsed,
                    notifications: { ...DEFAULTS.notifications, ...(parsed.notifications || {}) }
                };
            }
        } catch {
            /* fall back to defaults */
        }
        return { ...DEFAULTS, notifications: { ...DEFAULTS.notifications } };
    }

    /** Restore the last-run summary so a restart doesn't wipe "Last run" in the UI. */
    private _loadLastRun(): void {
        try {
            const raw = this.opts.db.kvGet(LAST_RUN_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as { lastRunAt?: string; lastRunResult?: string; seriesChecked?: number; newChaptersFound?: number };
                this.lastRunAt = parsed.lastRunAt;
                this.lastRunResult = parsed.lastRunResult;
                this.seriesChecked = parsed.seriesChecked ?? 0;
                this.newChaptersFound = parsed.newChaptersFound ?? 0;
            }
        } catch {
            /* non-fatal: status fields stay empty */
        }
    }

    private _saveLastRun(): void {
        try {
            this.opts.db.kvSet(
                LAST_RUN_KEY,
                JSON.stringify({
                    lastRunAt: this.lastRunAt,
                    lastRunResult: this.lastRunResult,
                    seriesChecked: this.seriesChecked,
                    newChaptersFound: this.newChaptersFound
                })
            );
        } catch {
            /* non-fatal */
        }
    }
    private _startJob(): void {
        this.job?.stop();
        this.job = undefined;
        if (!this.settings.enabled || !this.settings.cron) {
            return;
        }
        try {
            this.job = new Cron(this.settings.cron, () => {
                this.runNow().catch(error => console.error('[scheduler] run failed:', error));
            });
        } catch (error) {
            console.error(`[scheduler] invalid cron expression "${this.settings.cron}":`, (error as Error).message);
        }
    }

    private _publishStatus(): void {
        this.opts.events.publish({ type: 'schedule.status', status: this.status() });
    }
}
