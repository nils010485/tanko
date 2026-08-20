/**
 * Lightweight webhook notifications for new chapters.
 * Supports Discord webhooks (rich payload) and anything accepting a plain
 * text POST body (ntfy, gotify, custom endpoints).
 */
export interface NotificationSettings {
    enabled: boolean;
    webhookUrl: string;
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
