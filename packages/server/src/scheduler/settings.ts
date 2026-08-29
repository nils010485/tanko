/**
 * Scheduler settings + last-run persistence: the schedule block and the
 * last-run summary live in the database kv store so a restart never wipes
 * them. Extracted from Scheduler, which delegates.
 */
import type { Database } from '../db.js';
import { DEFAULT_EVENT_TOGGLES, mergeNotificationSettings, type NotificationSettings } from '../library/notify.js';

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
    notifications: { enabled: false, webhookUrl: '', events: { ...DEFAULT_EVENT_TOGGLES } }
};

const SETTINGS_KEY = 'schedule';
const LAST_RUN_KEY = 'schedule.lastrun';

/** Persisted summary of the last scheduler run (restored on restart). */
export interface LastRunSummary {
    lastRunAt?: string;
    lastRunResult?: string;
    seriesChecked: number;
    newChaptersFound: number;
}

export function loadSettings(db: Database): ScheduleSettings {
    try {
        const raw = db.kvGet(SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                ...DEFAULTS,
                ...parsed,
                notifications: mergeNotificationSettings(DEFAULTS.notifications, parsed.notifications)
            };
        }
    } catch {
        /* fall back to defaults */
    }
    return { ...DEFAULTS, notifications: { ...DEFAULTS.notifications } };
}

export function saveSettings(db: Database, settings: ScheduleSettings): void {
    db.kvSet(SETTINGS_KEY, JSON.stringify(settings));
}

/** Restore the last-run summary so a restart doesn't wipe "Last run" in the UI. */
export function loadLastRun(db: Database): LastRunSummary {
    try {
        const raw = db.kvGet(LAST_RUN_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as { lastRunAt?: string; lastRunResult?: string; seriesChecked?: number; newChaptersFound?: number };
            return {
                lastRunAt: parsed.lastRunAt,
                lastRunResult: parsed.lastRunResult,
                seriesChecked: parsed.seriesChecked ?? 0,
                newChaptersFound: parsed.newChaptersFound ?? 0
            };
        }
    } catch {
        /* non-fatal: status fields stay empty */
    }
    return { seriesChecked: 0, newChaptersFound: 0 };
}

export function saveLastRun(db: Database, summary: LastRunSummary): void {
    try {
        db.kvSet(LAST_RUN_KEY, JSON.stringify(summary));
    } catch {
        /* non-fatal */
    }
}
