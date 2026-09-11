/**
 * Shared source-list helpers (Discover picker and Sources admin view):
 * ranking, status labels and colors, kept here so the two views cannot drift.
 */

import type { SourceDto } from '@tanko/shared';
import type { TFunction } from '../i18n/index.js';
import { api } from './api.js';
import { pollUntil } from './poll.js';

/** Sort rank: natives first, then working, untested/checking, broken. */
export function sourceRank(source: SourceDto): number {
    if (source.kind === 'native') {
        return 0;
    }
    switch (source.health) {
        case 'ok':
            return 1;
        case 'error':
            return 3;
        default: // untested or still checking
            return 2;
    }
}

/** Short lowercase status label (e.g. table cells, picker rows). */
export function statusLabel(health: string | undefined, t: TFunction): string {
    switch (health) {
        case 'ok':
            return t('discover.statusOk');
        case 'error':
            return t('discover.statusError');
        case 'checking':
            return t('discover.statusChecking');
        default:
            return t('discover.statusUntested');
    }
}

/** Text color matching the health status. */
export function statusTextClass(health: string | undefined): string {
    switch (health) {
        case 'error':
            return 'text-red-400';
        case 'ok':
            return 'text-emerald-400';
        default:
            return 'text-muted';
    }
}

/** Re-check every source's health, polling until the background probe
 *  settles — shared by the Sources admin view and Discover's picker so the
 *  two cannot drift apart. */
export async function recheckAllSources(options: {
    refreshSources: () => Promise<SourceDto[]>;
    cancelled: () => boolean;
    onError: (message: string) => void;
    onStarted?: () => void;
}): Promise<void> {
    try {
        await api.checkSources();
        options.onStarted?.();
        await pollUntil(() => options.refreshSources(), {
            cancelled: options.cancelled,
            done: (list, attempt) => !list.some(source => source.health === 'checking') && attempt > 2
        });
    } catch (error) {
        options.onError((error as Error).message);
    }
}

/** Hide every source whose last health check failed (both source views). */
export async function hideBrokenSources(options: { refreshSources: () => Promise<SourceDto[]>; onError: (message: string) => void }): Promise<void> {
    try {
        await api.hideBroken();
        await options.refreshSources();
    } catch (error) {
        options.onError((error as Error).message);
    }
}
