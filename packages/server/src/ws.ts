/**
 * Event bus + WebSocket broadcast to the dashboard.
 * Server modules emit typed events; every connected WS client receives them
 * as JSON. Also keeps a ring buffer of recent events for late joiners.
 */

import type { WsEvent } from '@tanko/shared';
import { WebSocket } from 'ws';

const HISTORY_SIZE = 200;
const REPLAY_SIZE = 50;

type LogEvent = Extract<WsEvent, { type: 'log' }>;

export class EventBus {
    private readonly clients = new Set<WebSocket>();
    private readonly history: WsEvent[] = [];
    /** Optional persistence hook: stores a log event and returns its row id. */
    private logSink: ((event: LogEvent) => number | undefined) | undefined;

    /** Attach a persistence hook for `log` events (row id is tagged on the
     * broadcast copy so dashboards can dedupe against the REST history). */
    setLogSink(sink: (event: LogEvent) => number | undefined): void {
        this.logSink = sink;
    }

    /** Publish a structured activity log event; `at` defaults to now.
     *  Thin sugar over publish() so emit sites stay one-liners. */
    publishLog(event: Omit<LogEvent, 'type' | 'at'> & { at?: string }): void {
        this.publish({ type: 'log', at: new Date().toISOString(), ...event });
    }

    publish(event: WsEvent): void {
        if (event.type === 'log' && this.logSink) {
            const id = this.logSink(event);
            if (id !== undefined) {
                event = { ...event, id };
            }
        }
        this.history.push(event);
        if (this.history.length > HISTORY_SIZE) {
            this.history.splice(0, this.history.length - HISTORY_SIZE);
        }
        const data = JSON.stringify(event);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    attach(socket: WebSocket): void {
        this.clients.add(socket);
        for (const event of this.history.slice(-REPLAY_SIZE)) {
            socket.send(JSON.stringify(event));
        }
        socket.on('close', () => this.clients.delete(socket));
        socket.on('error', () => this.clients.delete(socket));
    }

    get clientCount(): number {
        return this.clients.size;
    }
}
