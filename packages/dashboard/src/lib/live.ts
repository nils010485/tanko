/**
 * Live state from the WebSocket event bus + REST snapshots.
 * Keeps jobs / library / schedule / logs in sync with the server.
 */

import type { DownloadJobDto, LibraryEntryDto, QueueStatusDto, ScheduleStatusDto, WsEvent } from '@tanko/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export interface LogLine {
    id: number;
    level: 'info' | 'warn' | 'error';
    message: string;
    at: string;
}

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
    const logSeq = useRef(0);

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
            // persisted history (newest first) — the WS replay dedupes against it by id
            setLogs(await api.activity().then(result => result.logs));
        } catch {
            /* ignore */
        }
    }, []);
    useEffect(() => {
        refreshJobs();
        refreshLibrary();
        refreshSchedule();
        refreshQueueStatus();
        refreshActivity();

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
                        case 'log':
                            setLogs(current => {
                                // events replayed right after the REST load carry the same row id — skip those
                                if (message.id !== undefined && current.some(log => log.id === message.id)) {
                                    return current;
                                }
                                return [
                                    { id: message.id ?? --logSeq.current, level: message.level, message: message.message, at: message.at },
                                    ...current
                                ].slice(0, 300);
                            });
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
    }, [refreshJobs, refreshLibrary, refreshSchedule, refreshQueueStatus, refreshActivity]);

    return { connected, jobs, jobsLoaded, library, libraryLoaded, queueStatus, schedule, logs, refreshLibrary, refreshJobs };
}
