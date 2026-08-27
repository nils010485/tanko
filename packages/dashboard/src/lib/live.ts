/**
 * Live state from the WebSocket event bus + REST snapshots.
 * Keeps jobs / library / schedule / logs in sync with the server.
 */

import type { ActivityLogDto, DownloadJobDto, LibraryEntryDto, QueueStatusDto, ScheduleStatusDto, WsEvent } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** One Activity tab line — structured event (WS `log` + REST history). */
export type LogLine = ActivityLogDto;

export interface LiveState {
    connected: boolean;
    jobs: DownloadJobDto[];
    jobsLoaded: boolean;
    library: LibraryEntryDto[];
    libraryLoaded: boolean;
    /** Authoritative queue counters, pushed over WS (null before the first snapshot). */
    queueStatus: QueueStatusDto | null;
    schedule: ScheduleStatusDto | null;
    logs: LogLine[];
    /** error-level events since the last Activity visit (sidebar badge). */
    unreadErrors: number;
    /** Bumped on every WS sources.updated — Discover refetches source health when it changes. */
    sourcesVersion: number;
    markActivitySeen: () => void;
    refreshLibrary: () => Promise<void>;
    refreshJobs: () => Promise<void>;
}

/** Insert-or-replace by id; prepend controls where new items appear. */
function upsert<T extends { id: number }>(list: T[], item: T, prepend = false): T[] {
    const index = list.findIndex(current => current.id === item.id);
    if (index === -1) {
        return prepend ? [item, ...list] : [...list, item];
    }
    const next = [...list];
    next[index] = item;
    return next;
}

export function useLiveState(): LiveState {
    const [connected, setConnected] = useState(false);
    const [jobs, setJobs] = useState<DownloadJobDto[]>([]);
    const [jobsLoaded, setJobsLoaded] = useState(false);
    const [library, setLibrary] = useState<LibraryEntryDto[]>([]);
    const [libraryLoaded, setLibraryLoaded] = useState(false);
    const [schedule, setSchedule] = useState<ScheduleStatusDto | null>(null);
    const [queueStatus, setQueueStatus] = useState<QueueStatusDto | null>(null);
    const [logs, setLogs] = useState<LogLine[]>([]);
    const [unreadErrors, setUnreadErrors] = useState(0);
    const [sourcesVersion, setSourcesVersion] = useState(0);
    const logSeq = useRef(0);
    /** Row ids already known (REST load or previous frames) — WS replay dedupe. */
    const seenLogIds = useRef<Set<number>>(new Set());

    const refreshJobs = useCallback(async () => {
        try {
            setJobs((await api.downloads()).jobs);
            setJobsLoaded(true);
        } catch {
            /* server may be briefly unavailable */
        }
    }, []);

    const refreshLibrary = useCallback(async () => {
        try {
            setLibrary(await api.library());
            setLibraryLoaded(true);
        } catch {
            /* ignore */
        }
    }, []);

    const refreshSchedule = useCallback(async () => {
        try {
            const data = await api.schedule();
            setSchedule(data.status);
        } catch {
            /* ignore */
        }
    }, []);

    const refreshQueueStatus = useCallback(async () => {
        try {
            setQueueStatus(await api.downloadStatus());
        } catch {
            /* ignore */
        }
    }, []);

    const refreshActivity = useCallback(async () => {
        try {
            // persisted history (newest first) — replayed WS frames dedupe against these ids
            const fresh = await api.activity().then(result => result.logs);
            seenLogIds.current = new Set(fresh.map(log => log.id));
            setLogs(fresh);
        } catch {
            /* ignore */
        }
    }, []);
    const refreshUnread = useCallback(async () => {
        const seenAt = localStorage.getItem('tanko.activitySeenAt');
        if (!seenAt) {
            return;
        }
        try {
            const stats = await api.activityStats(seenAt);
            setUnreadErrors(stats.errorsSince ?? 0);
        } catch {
            /* ignore */
        }
    }, []);
    const markActivitySeen = useCallback(() => {
        localStorage.setItem('tanko.activitySeenAt', new Date().toISOString());
        setUnreadErrors(0);
    }, []);
    useEffect(() => {
        refreshJobs();
        refreshLibrary();
        refreshSchedule();
        refreshQueueStatus();
        refreshActivity();
        refreshUnread();

        let disposed = false;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let socket: WebSocket | null = null;

        const connect = () => {
            if (disposed) {
                return;
            }
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
            socket = ws;
            ws.onopen = () => {
                setConnected(true);
                // missed events while disconnected (queue cleared, jobs finished…) — resync
                refreshJobs();
                refreshLibrary();
                refreshSchedule();
                refreshQueueStatus();
                refreshActivity();
                refreshUnread();
            };
            socket.onclose = () => {
                setConnected(false);
                retry = setTimeout(connect, 2500);
            };
            ws.onerror = () => ws.close();
            socket.onmessage = event => {
                try {
                    const message = JSON.parse(event.data) as WsEvent;
                    switch (message.type) {
                        case 'job.updated':
                            setJobs(current => upsert(current, message.job, true));
                            break;
                        case 'job.removed':
                            setJobs(current => current.filter(job => job.id !== message.jobId));
                            break;
                        case 'library.updated':
                            // the event may be published without the cover decoration; keep the last known coverUrl
                            setLibrary(current =>
                                upsert(
                                    current,
                                    message.entry.coverUrl
                                        ? message.entry
                                        : { ...message.entry, coverUrl: current.find(entry => entry.id === message.entry.id)?.coverUrl }
                                )
                            );
                            break;
                        case 'queue.status':
                            setQueueStatus(message.status);
                            break;
                        case 'schedule.status':
                            setSchedule(message.status);
                            break;
                        case 'sources.updated':
                            setSourcesVersion(version => version + 1);
                            break;
                        case 'log':
                            // replayed frames (reconnect) carry ids the REST load already
                            // returned — skipping them keeps the unread counter honest
                            if (message.id !== undefined && seenLogIds.current.has(message.id)) {
                                break;
                            }
                            if (message.id !== undefined) {
                                seenLogIds.current.add(message.id);
                            }
                            if (message.level === 'warn' || message.level === 'error') {
                                setUnreadErrors(current => current + 1);
                            }
                            setLogs(current =>
                                [{ ...message, id: message.id ?? --logSeq.current, category: message.category ?? 'system' }, ...current].slice(0, 300)
                            );
                            break;
                    }
                } catch {
                    /* non-JSON frame */
                }
            };
        };

        connect();
        return () => {
            disposed = true;
            clearTimeout(retry);
            socket?.close();
        };
    }, [refreshJobs, refreshLibrary, refreshSchedule, refreshQueueStatus, refreshActivity, refreshUnread]);

    return {
        connected,
        jobs,
        jobsLoaded,
        library,
        libraryLoaded,
        queueStatus,
        schedule,
        logs,
        unreadErrors,
        sourcesVersion,
        markActivitySeen,
        refreshLibrary,
        refreshJobs
    };
}
