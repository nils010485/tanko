/**
 * Activity view: live log stream from the event bus.
 */

import { IconActivity } from '../components/icons.js';
import { Badge, Card, EmptyState, SectionTitle } from '../components/ui.js';
import { useI18n } from '../i18n/index.js';
import type { LogLine } from '../lib/live.js';

export default function Activity({ logs }: { logs: LogLine[] }) {
    const { t, formatDate } = useI18n();

    return (
        <div className="space-y-6">
            <SectionTitle>{t('activity.title')}</SectionTitle>

            {logs.length === 0 && <EmptyState title={t('activity.empty')} hint={t('activity.emptyHint')} icon={<IconActivity size={28} />} />}

            <Card className="divide-y divide-zinc-800/70">
                {logs.map(log => (
                    <div key={log.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                        <Badge tone={log.level === 'error' ? 'red' : log.level === 'warn' ? 'orange' : 'zinc'}>{log.level}</Badge>
                        <span className="min-w-0 flex-1 break-words text-zinc-300">{log.message}</span>
                        <span className="flex-none text-xs text-zinc-600">{formatDate(log.at)}</span>
                    </div>
                ))}
            </Card>
        </div>
    );
}
