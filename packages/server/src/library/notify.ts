/**
 * Lightweight webhook notifications.
 * Supports Discord webhooks (rich payload) and anything accepting a plain
 * text POST body (ntfy, gotify, custom endpoints). Delivery is opt-in per
 * event type (NotificationEventToggles) — by default only new chapters
 * notify, preserving the historical behavior.
 */
import type { NotificationEventToggles } from '@tanko/shared';

export interface NotificationSettings {
    enabled: boolean;
    webhookUrl: string;
    events?: Partial<NotificationEventToggles>;
}

/** Event types that can trigger a webhook. */
export type NotificationEvent = keyof NotificationEventToggles;

/** Opt-in defaults: only new chapters notify. */
export const DEFAULT_EVENT_TOGGLES: NotificationEventToggles = { newChapters: true, outages: false, migrations: false, scans: false };

/** Whether `event` should fire a webhook under `settings`. */

/** Merge notification settings over the defaults: nested `events` merge and
 *  boolean coercion — HTTP clients may send untyped values. */
export function mergeNotificationSettings(base: NotificationSettings, patch?: Partial<NotificationSettings>): NotificationSettings {
    const events = { ...DEFAULT_EVENT_TOGGLES, ...(base.events || {}), ...(patch?.events || {}) };
    for (const key of Object.keys(events) as Array<keyof NotificationEventToggles>) {
        events[key] = events[key] === true;
    }
    return { ...base, ...(patch || {}), events };
}
export function notificationEnabled(settings: NotificationSettings, event: NotificationEvent): boolean {
    return settings.enabled && !!settings.webhookUrl && (settings.events?.[event] ?? DEFAULT_EVENT_TOGGLES[event]);
}

export async function sendNotification(settings: NotificationSettings, title: string, body: string): Promise<boolean> {
    if (!settings.enabled || !settings.webhookUrl) {
        return false;
    }
    try {
        const isDiscord = /discord(app)?\.com\/api\/webhooks/i.test(settings.webhookUrl);
        const init: RequestInit = isDiscord
            ? {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ content: `**${title}**\n${body}` })
              }
            : {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title },
                  body: `${title}\n${body}`
              };
        const response = await fetch(settings.webhookUrl, { ...init, signal: AbortSignal.timeout(15000) });
        return response.ok;
    } catch (error) {
        console.warn('[notify] webhook failed:', (error as Error).message);
        return false;
    }
}
