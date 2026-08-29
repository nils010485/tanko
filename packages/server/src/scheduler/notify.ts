/**
 * Scheduler notifications: the new-chapters webhook and the failover log
 * messages. Extracted from Scheduler, which delegates.
 */
import { type NotificationSettings, notificationEnabled, sendNotification } from '../library/notify.js';

/** Log message for a failover outcome. */
export function failoverMessage(title: string, outcome: 'migrated' | 'suggested' | 'none'): string {
    switch (outcome) {
        case 'migrated':
            return `"${title}" migré automatiquement vers une autre source`;
        case 'suggested':
            return `"${title}" : migration de source suggérée (à confirmer)`;
        default:
            return `"${title}" : aucune source de rechange trouvée`;
    }
}

/** Send the new-chapters webhook notification. */
export async function notifyNewChapters(notifications: NotificationSettings, newBySeries: Array<{ title: string; chapters: string[] }>): Promise<void> {
    if (!notificationEnabled(notifications, 'newChapters')) {
        return;
    }
    const body = newBySeries.map(item => `• ${item.title}: ${item.chapters.slice(0, 5).join(', ')}${item.chapters.length > 5 ? '…' : ''}`).join('\n');
    await sendNotification(notifications, 'New chapters available', body);
}
