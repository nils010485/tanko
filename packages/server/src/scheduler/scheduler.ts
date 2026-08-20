/**
 * Scheduler: periodically checks every library entry for new chapters.
 * New chapters are flagged in the library and (optionally) auto-enqueued
 * into the download queue. Status is published on the WebSocket bus.
 */

import type { LibraryEntryDto, ScheduleStatusDto } from '@tanko/shared';
import { Cron } from 'croner';
import type { Database } from '../db.js';
import type { DownloadQueue } from '../downloader/queue.js';
import { type NotificationSettings, sendNotification } from '../library/notify.js';
import type { ChapterRow, LibraryStore } from '../library/store.js';
import type { EventBus } from '../ws.js';

const SETTINGS_KEY = 'schedule';

export interface ScheduleSettings {
    enabled: boolean;
    cron: string;
    autoDownload: boolean;
    notifications: NotificationSettings;
}

const DEFAULTS: ScheduleSettings = {
    enabled: true,
    cron: '0 */6 * * *',
    autoDownload: true,
    notifications: { enabled: false, webhookUrl: '' }
};

export class Scheduler {
    private job: Cron | undefined;
    private settings: ScheduleSettings;
    private running = false;
    private lastRunAt?: string;
    private lastRunResult?: string;
    private seriesChecked = 0;
    private newChaptersFound = 0;

    constructor(
        private readonly opts: {
            db: Database;
            store: LibraryStore;
            queue: DownloadQueue;
            events: EventBus;
            /** Optional source failover: invoked after repeated check failures. */
            failover?: { maybeMigrate(entry: { id: number; sourceId: string; title: string }, auto?: boolean): Promise<'migrated' | 'suggested' | 'none'> };
        }
    ) {
        this.settings = this._load();
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
        this.opts.db.kvSet(SETTINGS_KEY, JSON.stringify(this.settings));
        this._startJob();
        this._publishStatus();
        return this.getSettings();
    }

    // ------------------------------------------------------------------
    // runs
    // ------------------------------------------------------------------

    async runNow(): Promise<{ checked: number; newChapters: number }> {
        if (this.running) {
            return { checked: 0, newChapters: 0 };
        }
        this.running = true;
        const startedAt = Date.now();
        let checked = 0;
        let totalNew = 0;
        const newBySeries: Array<{ title: string; chapters: string[] }> = [];
        try {
            const entries = await this.opts.store.listEntries();
            for (const entry of entries) {
                // small jitter between series checks to stay polite with sources
                await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 1200));
                try {
                    const fresh = await this._checkEntry(entry);
                    checked++;
                    totalNew += fresh.length;
                    if (fresh.length > 0) {
                        newBySeries.push({ title: entry.title, chapters: fresh.map(chapter => chapter.title) });
                    }
                } catch (error) {
                    await this._handleCheckFailure(entry, error);
                }
            }

            // entries whose downloads keep failing on a source that still answers
            // checks (reachable site, broken pages) deserve a failover too
            if (this.opts.failover) {
                for (const entry of this.opts.store.listDownloadFailing(3)) {
                    try {
                        const outcome = await this.opts.failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                        this.opts.events.publish({
                            type: 'log',
                            level: outcome === 'migrated' ? 'info' : 'warn',
                            message: `${this._failoverMessage(entry.title, outcome)} (${entry.downloadFailures} téléchargements en échec)`,
                            at: new Date().toISOString()
                        });
                    } catch (error) {
                        console.warn(`[failover] "${entry.title}":`, (error as Error).message);
                    }
                    // reset even when nothing was found: implicit backoff, the
                    // failover will only re-arm after 3 fresh download failures
                    this.opts.store.resetDownloadFailures(entry.id);
                }
            }

            this.lastRunResult = `checked ${checked} series, ${totalNew} new chapter(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
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
            this._publishStatus();
        }
        return { checked, newChapters: totalNew };
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
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /** Check one entry for new chapters; logs, auto-enqueues and returns the fresh chapters. */
    private async _checkEntry(entry: LibraryEntryDto): Promise<ChapterRow[]> {
        const { fresh, usableSeen } = await this.opts.store.checkForNewChapters(entry.id);
        if (usableSeen === 0 && (entry.downloadedCount > 0 || entry.autoDownload)) {
            // La source ne référence plus aucun chapitre dans les langues préférées
            // (retrait pour licence typiquement) alors que la série est suivie —
            // déjà téléchargée ou en attente de nouveautés : compter comme un échec
            // pour armer le failover au lieu de rester silencieusement à « 0 nouveau ».
            await this._handleCheckFailure(entry, new Error('la source ne référence plus aucun chapitre dans les langues préférées'));
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

    /** A series check failed: log it, count the failure, and try a failover after repeated failures. */
    private async _handleCheckFailure(entry: LibraryEntryDto, error: unknown): Promise<void> {
        this.opts.events.publish({
            type: 'log',
            level: 'warn',
            message: `Check failed for "${entry.title}" (${entry.sourceLabel}): ${(error as Error).message}`,
            at: new Date().toISOString()
        });
        // repeated failures -> the source is probably dead for this series: try a failover
        const failures = this.opts.store.recordCheckFailure(entry.id);
        // attempt at the 3rd failure, then sparsely (every 20th): probing the
        // alternative sources is slow, it must not dominate every scheduled run
        if (failures < 3 || (failures !== 3 && failures % 20 !== 0) || !this.opts.failover) {
            return;
        }
        try {
            const outcome = await this.opts.failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            this.opts.events.publish({
                type: 'log',
                level: outcome === 'migrated' ? 'info' : 'warn',
                message: this._failoverMessage(entry.title, outcome),
                at: new Date().toISOString()
            });
            this._publishEntryUpdated(entry.id);
        } catch (migrationError) {
            console.warn(`[failover] "${entry.title}":`, (migrationError as Error).message);
        }
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
