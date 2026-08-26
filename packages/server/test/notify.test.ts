import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_TOGGLES, mergeNotificationSettings, type NotificationSettings, notificationEnabled } from '../src/library/notify.js';

const base: NotificationSettings = { enabled: true, webhookUrl: 'https://ntfy.sh/topic' };

describe('webhook notification gating', () => {
    it('defaults to new chapters only (the historical behavior)', () => {
        expect(notificationEnabled(base, 'newChapters')).toBe(true);
        expect(notificationEnabled(base, 'outages')).toBe(false);
        expect(notificationEnabled(base, 'migrations')).toBe(false);
        expect(notificationEnabled(base, 'scans')).toBe(false);
        expect(DEFAULT_EVENT_TOGGLES).toEqual({ newChapters: true, outages: false, migrations: false, scans: false });
    });

    it('honours explicit opt-in toggles', () => {
        const settings: NotificationSettings = { ...base, events: { newChapters: false, outages: true } };
        expect(notificationEnabled(settings, 'newChapters')).toBe(false);
        expect(notificationEnabled(settings, 'outages')).toBe(true);
        // untouched toggles keep falling back to the defaults
        expect(notificationEnabled(settings, 'migrations')).toBe(false);
    });

    it('requires the webhook to be enabled and configured', () => {
        expect(notificationEnabled({ ...base, enabled: false }, 'newChapters')).toBe(false);
        expect(notificationEnabled({ ...base, webhookUrl: '' }, 'newChapters')).toBe(false);
    });

    it('merges nested event toggles and coerces non-boolean values', () => {
        const merged = mergeNotificationSettings(base, { events: { outages: 'yes' as unknown as boolean, scans: true } });
        expect(merged.events).toEqual({ newChapters: true, outages: false, migrations: false, scans: true });
        expect(mergeNotificationSettings({ ...base, events: { newChapters: false } }, { events: { migrations: true } }).events).toEqual({
            newChapters: false,
            outages: false,
            migrations: true,
            scans: false
        });
    });
});
