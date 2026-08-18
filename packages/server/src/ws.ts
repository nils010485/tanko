/**
 * Event bus + WebSocket broadcast to the dashboard.
 * Server modules emit typed events; every connected WS client receives them
 * as JSON. Also keeps a ring buffer of recent events for late joiners.
 */
import { WebSocket } from 'ws';
import type { WsEvent } from '@tanko/shared';

const HISTORY_SIZE = 200;
const REPLAY_SIZE = 50;

export class EventBus {

    private readonly clients = new Set<WebSocket>();
    private readonly history: WsEvent[] = [];

    publish(event: WsEvent): void {
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
