import fs from 'node:fs';
import path from 'node:path';
import { reloadOverrides } from '@tanko/core';
import type { SourcesPackInfo, SourcesPackStatus } from '@tanko/shared';
import type { Database } from '../db.js';

const DEFAULT_PACK_URL = 'https://raw.githubusercontent.com/nils010485/tanko/main/app/sources-pack.json';
const PACK_URL = process.env.SOURCES_PACK_URL || DEFAULT_PACK_URL;
const POLL_KICKOFF_MS = 60_000;
const POLL_MS = 24 * 60 * 60 * 1000;
const URL_KEYS = /^(base|api|url|referer|origin|imageServer)$/;

export const SOURCES_PACK_KEY = 'sources-pack-update';

export type { SourcesPackInfo, SourcesPackStatus };

export interface SourcesPack {
    version: string;
    sources: Record<string, Record<string, unknown>>;
}

let running = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollKickoff: ReturnType<typeof setTimeout> | undefined;

export function validatePack(pack: unknown): SourcesPack {
    if (typeof pack !== 'object' || pack === null) {
        throw new Error('Pack de sources invalide');
    }
    const { version, sources } = pack as { version?: unknown; sources?: unknown };
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error('Pack de sources invalide : version');
    }
    if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) {
        throw new Error('Pack de sources invalide : sources');
    }
    for (const [id, values] of Object.entries(sources as Record<string, unknown>)) {
        if (typeof values !== 'object' || values === null || Array.isArray(values)) {
            throw new Error(`Pack de sources invalide : ${id}`);
        }
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
            const scalar = typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
            const list = Array.isArray(value) && value.every(item => typeof item === 'string');
            const map = typeof value === 'object' && value !== null && Object.values(value).every(item => typeof item === 'string');
            if (!scalar && !list && !map) {
                throw new Error(`Pack de sources invalide : ${id}.${key}`);
            }
            if (typeof value === 'string' && URL_KEYS.test(key) && !value.startsWith('https://')) {
                throw new Error(`Pack de sources invalide (https requis) : ${id}.${key}`);
            }
        }
    }
    return { version, sources: sources as SourcesPack['sources'] };
}

export async function syncSourcesPack(options: { dataDirectory: string; db: Database; url?: string }): Promise<SourcesPackInfo> {
    if (running) {
        throw new Error('Une mise à jour des sources est déjà en cours');
    }
    running = true;
    try {
        let appliedVersion: string | undefined;
        try {
            const raw = options.db.kvGet(SOURCES_PACK_KEY);
            appliedVersion = raw ? (JSON.parse(raw) as { version: string }).version : undefined;
        } catch {
            appliedVersion = undefined;
        }
        const response = await fetch(options.url ?? PACK_URL, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} sur le pack de sources`);
        }
        const pack = validatePack(await response.json());
        const info: SourcesPackInfo = { date: new Date().toISOString(), version: pack.version, applied: false };
        if (pack.version !== appliedVersion) {
            const target = path.join(options.dataDirectory, 'sources-overrides.json');
            const temp = `${target}.tmp`;
            fs.writeFileSync(temp, JSON.stringify({ sources: pack.sources }, null, 2));
            fs.renameSync(temp, target);
            reloadOverrides();
            info.applied = true;
            options.db.kvSet(SOURCES_PACK_KEY, JSON.stringify(info));
        }
        return info;
    } finally {
        running = false;
    }
}

export function isPackRunning(): boolean {
    return running;
}

export function getPackStatus(db: Database): SourcesPackStatus {
    let last: SourcesPackStatus['last'] = null;
    try {
        const raw = db.kvGet(SOURCES_PACK_KEY);
        const parsed = raw ? (JSON.parse(raw) as { date: string; version: string }) : null;
        last = parsed ? { date: parsed.date, version: parsed.version } : null;
    } catch {
        last = null;
    }
    return { running, last };
}

export function startPackPolling(options: { dataDirectory: string; db: Database; onApplied?: () => void }): void {
    const poll = async () => {
        try {
            const info = await syncSourcesPack(options);
            if (info.applied) {
                console.log(`[sources-pack] applied version ${info.version}`);
                options.onApplied?.();
            }
        } catch (error) {
            console.warn('[sources-pack] poll failed:', (error as Error).message);
        }
    };
    pollKickoff = setTimeout(() => void poll(), POLL_KICKOFF_MS);
    pollTimer = setInterval(() => void poll(), POLL_MS);
}

export function stopPackPolling(): void {
    if (pollKickoff) {
        clearTimeout(pollKickoff);
    }
    if (pollTimer) {
        clearInterval(pollTimer);
    }
    pollKickoff = pollTimer = undefined;
}
