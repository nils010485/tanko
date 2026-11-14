/**
 * Host side of the connector workers: a bounded pool of processes that run
 * legacy connectors (synchronous HTML parsing, catalog crawls) away from the
 * server's event loop.
 *
 * Sticky assignment: a connector lives on exactly one worker for its lifetime,
 * because connectors keep state (caches, locks, initialized flag) between
 * calls. Session state stays here - worker requests are proxied through the
 * pool's HeadlessRequest (cookies, header transforms, backoffs) and anti-bot
 * rendering through the pool's Chromium renderer.
 */
import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectorCommand, ConnectorEvent, RenderOptions, RenderResult } from './connector-worker.js';
import type { WireRequest, WireResponse } from './evaluate-child.js';
import { type HeadlessRequest, HostGate } from './request.js';

const require = createRequire(import.meta.url);

const DEFAULT_POOL_SIZE = 4;
const DEFAULT_OP_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 20_000;

type SpawnMode = 'unknown' | 'hardened' | 'plain';
/** Same ladder as evaluate.ts: a refused hardened spawn degrades once to a plain one. */
let spawnMode: SpawnMode = 'unknown';
/** Indirection: keeps TS control-flow analysis from over-narrowing the module state. */
function currentSpawnMode(): SpawnMode {
    return spawnMode;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The compiled worker in production; when the pool itself runs from source
 * (vitest) the built package copy, since a forked process cannot read TS.
 */
function workerEntry(): string {
    const candidates = [
        fileURLToPath(new URL('./connector-worker.js', import.meta.url)),
        fileURLToPath(new URL('../../dist/shims/connector-worker.js', import.meta.url))
    ];
    const entry = candidates.find(candidate => fs.existsSync(candidate));
    if (!entry) {
        throw new Error(`connector worker entry not found (looked for ${candidates.join(', ')}) - build @tanko/core first`);
    }
    return entry;
}

/**
 * Read allow-list of the hardened worker: the root that serves this package
 * and its dependencies (workspace hoisting aware), plus the connector's vendor
 * tree - connectors import '../engine/Connector.mjs' and sibling templates.
 */
function dependencyRoot(): string {
    const resolved = require.resolve('linkedom');
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = resolved.lastIndexOf(marker);
    return index < 0 ? path.dirname(resolved) : resolved.slice(0, index);
}

interface Slot {
    child?: ChildProcess;
    /** A spawn that has not answered 'ready' yet (dispose must kill it too). */
    spawning?: ChildProcess;
    ready?: Promise<ChildProcess>;
    filePath?: string;
    loaded: Set<string>;
}

interface PendingOp {
    opId: number;
    child: ChildProcess;
    connectorId: string;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface PendingLoad {
    connectorId: string;
    child: ChildProcess;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
    reject: (error: Error) => void;
}

export interface ConnectorPoolOptions {
    request: HeadlessRequest;
    size?: number;
    renderPage?: (url: string, options: RenderOptions) => Promise<RenderResult>;
    /** Per-operation budget; expiry kills (recycles) the worker. */
    opTimeoutMs?: number;
}

export class ConnectorPool {
    private readonly request: HeadlessRequest;
    private readonly renderPage?: (url: string, options: RenderOptions) => Promise<RenderResult>;
    /** Worker fetches honor the same browser-like per-host cap as the host session's sandboxed ones. */
    private readonly gate = new HostGate();
    private readonly opTimeoutMs: number;
    private readonly slots: Slot[];
    /** connectorId -> slot: a connector never moves, its state lives in that process. */
    private readonly assignments = new Map<string, number>();
    private readonly loads = new Map<string, { child: ChildProcess; promise: Promise<void> }>();
    private readonly pendingOps = new Map<number, PendingOp>();
    private readonly pendingLoads = new Map<string, PendingLoad>();
    private nextOpId = 1;
    private cursor = 0;
    private disposed = false;

    constructor(options: ConnectorPoolOptions) {
        const size = options.size ?? Math.min(os.cpus().length, DEFAULT_POOL_SIZE);
        if (!Number.isInteger(size) || size < 1) {
            throw new Error(`connector pool size must be a positive integer (got ${size})`);
        }
        this.request = options.request;
        this.renderPage = options.renderPage;
        this.opTimeoutMs = options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
        this.slots = Array.from({ length: size }, () => ({ loaded: new Set<string>() }));
    }

    /**
     * Run one connector method on the worker owning `connectorId`.
     * `manga`/`chapter` arguments are plain `{ id, title }` records - the
     * worker re-attaches the connector instance itself.
     */
    async run<T>(connectorId: string, filePath: string, method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
        if (this.disposed) {
            throw new Error('connector pool is disposed');
        }
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
        }
        const slotIndex = this.assign(connectorId);
        const child = await this.ensureWorker(slotIndex, filePath);
        await this.ensureLoaded(slotIndex, connectorId, filePath, child);

        const opId = this.nextOpId++;
        const value = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                // the op may hold the worker in a synchronous parse forever:
                // settling is not enough, the process has to go
                this.settleOp(this.pendingOps.get(opId), false, new Error(`connector ${method} timed out after ${this.opTimeoutMs}ms`));
                this.recycle(slotIndex);
            }, this.opTimeoutMs);
            timer.unref?.();
            const onAbort = () => void this.cancel(connectorId, opId);
            signal?.addEventListener('abort', onAbort, { once: true });
            this.pendingOps.set(opId, { opId, child, connectorId, timer, signal, onAbort, resolve, reject });
            this.syncRef(child);
            child.send({ type: 'op', opId, connectorId, method, args } satisfies ConnectorCommand, error => {
                if (error) {
                    this.settleOp(this.pendingOps.get(opId), false, error);
                }
            });
        });
        return value as T;
    }

    /** Ask the worker to abort an operation (its in-flight fetches die with it). */
    async cancel(connectorId: string, opId: number): Promise<void> {
        const op = this.pendingOps.get(opId);
        if (!op || op.connectorId !== connectorId) {
            return;
        }
        this.reply(op.child, { type: 'cancel', opId });
    }

    /** Kill every worker; the pool is unusable afterwards. */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const op of [...this.pendingOps.values()]) {
            this.settleOp(op, false, new Error('connector pool is disposed'));
        }
        for (const load of [...this.pendingLoads.values()]) {
            clearTimeout(load.timer);
            this.pendingLoads.delete(load.connectorId);
            load.reject(new Error('connector pool is disposed'));
        }
        const exits: Array<Promise<void>> = [];
        for (const slot of this.slots) {
            for (const child of [slot.child, slot.spawning]) {
                if (!child || child.exitCode !== null || child.signalCode !== null) {
                    continue;
                }
                exits.push(new Promise<void>(resolve => child.once('exit', () => resolve())));
                child.ref(); // unref'd child: the loop must live until it is reaped
                child.kill('SIGKILL');
            }
            slot.child = undefined;
            slot.spawning = undefined;
            slot.loaded.clear();
        }
        await Promise.all(exits);
    }

    private assign(connectorId: string): number {
        const known = this.assignments.get(connectorId);
        if (known !== undefined) {
            return known;
        }
        const slotIndex = this.cursor++ % this.slots.length;
        this.assignments.set(connectorId, slotIndex);
        return slotIndex;
    }

    private async ensureWorker(slotIndex: number, filePath: string): Promise<ChildProcess> {
        const slot = this.slots[slotIndex];
        if (slot.child) {
            return slot.child;
        }
        slot.filePath = filePath;
        let pending = slot.ready;
        if (!pending) {
            pending = this.spawn(slotIndex).finally(() => {
                slot.ready = undefined;
            });
            slot.ready = pending;
        }
        return await pending;
    }

    /** hardened worker > plain worker; no in-process fallback (that is the bug being fixed). */
    private async spawn(slotIndex: number): Promise<ChildProcess> {
        if (currentSpawnMode() === 'plain') {
            return await this.forkSlot(slotIndex, false);
        }
        try {
            return await this.forkSlot(slotIndex, true);
        } catch (error) {
            if (currentSpawnMode() !== 'plain') {
                throw error;
            }
            return await this.forkSlot(slotIndex, false);
        }
    }

    private forkSlot(slotIndex: number, hardened: boolean): Promise<ChildProcess> {
        if (this.disposed) {
            throw new Error('connector pool is disposed');
        }
        const slot = this.slots[slotIndex];
        const entry = workerEntry();
        const connectorDirectory = slot.filePath ? path.dirname(slot.filePath) : undefined;
        const execArgv = hardened
            ? [
                  '--permission',
                  `--allow-fs-read=${dependencyRoot()}`,
                  ...(connectorDirectory ? [`--allow-fs-read=${connectorDirectory}`, `--allow-fs-read=${path.dirname(connectorDirectory)}`] : [])
              ]
            : [];
        const child = fork(entry, { serialization: 'advanced', env: { TANKO_CONNECTOR_WORKER: '1' }, execArgv, stdio: 'ignore' });
        child.unref(); // the pool owns the lifecycle, not the event loop
        slot.spawning = child;

        return new Promise<ChildProcess>((resolve, reject) => {
            let ready = false;
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`connector worker did not become ready within ${READY_TIMEOUT_MS}ms`));
            }, READY_TIMEOUT_MS);
            timer.unref?.();
            child.on('message', (message: ConnectorEvent) => {
                if (message.type === 'ready') {
                    ready = true;
                    clearTimeout(timer);
                    spawnMode = hardened ? 'hardened' : 'plain';
                    slot.spawning = undefined;
                    slot.child = child;
                    resolve(child);
                    return;
                }
                this.onEvent(slotIndex, child, message);
            });
            child.on('exit', (code, signal) => {
                const reason = `connector worker exited (code ${String(code)}, signal ${String(signal)})`;
                if (!ready) {
                    // refused to boot (permission model, missing flag): degrade once
                    spawnMode = 'plain';
                    clearTimeout(timer);
                    reject(new Error(reason));
                }
                if (slot.spawning === child) {
                    slot.spawning = undefined;
                }
                this.onWorkerGone(slotIndex, child, reason);
            });
            child.on('error', (error: Error) => {
                const reason = `connector worker error: ${error.message}`;
                if (!ready) {
                    spawnMode = 'plain';
                    clearTimeout(timer);
                    reject(new Error(reason));
                }
                this.onWorkerGone(slotIndex, child, reason);
            });
        });
    }

    private ensureLoaded(slotIndex: number, connectorId: string, filePath: string, child: ChildProcess): Promise<void> {
        if (this.slots[slotIndex].loaded.has(connectorId)) {
            return Promise.resolve();
        }
        // a load in flight on a recycled (dead) worker must not fail the new one
        const pending = this.loads.get(connectorId);
        if (pending && pending.child === child) {
            return pending.promise;
        }
        const promise = this.loadConnector(connectorId, filePath, child).finally(() => this.loads.delete(connectorId));
        this.loads.set(connectorId, { child, promise });
        return promise;
    }

    private loadConnector(connectorId: string, filePath: string, child: ChildProcess): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingLoads.delete(connectorId);
                reject(new Error(`connector "${connectorId}" load timed out after ${this.opTimeoutMs}ms`));
            }, this.opTimeoutMs);
            timer.unref?.();
            this.pendingLoads.set(connectorId, { connectorId, child, timer, resolve, reject });
            this.syncRef(child);
            child.send({ type: 'load', connectorId, filePath, userAgent: this.request.userAgent } satisfies ConnectorCommand, error => {
                if (error) {
                    clearTimeout(timer);
                    this.pendingLoads.delete(connectorId);
                    reject(error);
                }
            });
        });
    }

    private onEvent(slotIndex: number, child: ChildProcess, message: ConnectorEvent): void {
        switch (message.type) {
            case 'loaded': {
                const load = this.pendingLoads.get(message.connectorId);
                if (!load || load.child !== child) {
                    return;
                }
                clearTimeout(load.timer);
                this.pendingLoads.delete(message.connectorId);
                if (message.ok) {
                    this.slots[slotIndex].loaded.add(message.connectorId);
                    load.resolve();
                } else {
                    load.reject(new Error(message.error));
                }
                return;
            }
            case 'op-result': {
                const op = this.pendingOps.get(message.opId);
                if (!op || op.child !== child) {
                    return;
                }
                this.settleOp(op, message.ok, message.ok ? message.value : new Error(message.error));
                return;
            }
            case 'fetch':
                void this.answerFetch(child, message);
                return;
            case 'render':
                void this.answerRender(child, message);
                return;
            default:
                return;
        }
    }

    private async answerFetch(child: ChildProcess, message: { reqId: number; request: WireRequest }): Promise<void> {
        try {
            const wire = message.request;
            const request = {
                url: wire.url,
                method: wire.method,
                headers: new Headers(wire.headers),
                _body: wire.bodyB64 ? Buffer.from(wire.bodyB64, 'base64') : undefined
            };
            const response = await this.gate.run(wire.url, () => this.request.fetch(request, wire.timeoutMs));
            const bodyB64 = Buffer.from(await response.arrayBuffer()).toString('base64');
            const answer: WireResponse = { status: response.status, headers: [...response.headers.entries()], bodyB64, url: response.url };
            this.reply(child, { type: 'fetch-result', reqId: message.reqId, response: answer });
        } catch (error) {
            this.reply(child, { type: 'fetch-error', reqId: message.reqId, message: errorMessage(error) });
        }
    }

    private async answerRender(child: ChildProcess, message: { reqId: number; url: string; opts: RenderOptions }): Promise<void> {
        if (!this.renderPage) {
            this.reply(child, { type: 'render-error', reqId: message.reqId, message: 'no page renderer configured' });
            return;
        }
        try {
            const rendered = await this.renderPage(message.url, message.opts);
            this.reply(child, { type: 'render-result', reqId: message.reqId, html: rendered.html, finalUrl: rendered.finalUrl });
        } catch (error) {
            this.reply(child, { type: 'render-error', reqId: message.reqId, message: errorMessage(error) });
        }
    }

    private reply(child: ChildProcess, message: ConnectorCommand): void {
        if (!child.connected) {
            return;
        }
        child.send(message, () => undefined);
    }

    private settleOp(op: PendingOp | undefined, ok: boolean, value: unknown): void {
        if (!op) {
            return;
        }
        clearTimeout(op.timer);
        if (op.onAbort && op.signal) {
            op.signal.removeEventListener('abort', op.onAbort);
        }
        this.pendingOps.delete(op.opId);
        if (ok) {
            op.resolve(value);
        } else {
            op.reject(value instanceof Error ? value : new Error(String(value)));
        }
        this.syncRef(op.child);
    }

    /** Workers never pin the host event loop: only an in-flight call does. */
    private syncRef(child: ChildProcess): void {
        const busy = [...this.pendingOps.values()].some(op => op.child === child) || [...this.pendingLoads.values()].some(load => load.child === child);
        if (busy) {
            child.ref();
        } else {
            child.unref();
        }
    }

    /** A crashed or timed-out worker holds no reloadable state: drop it, respawn on next use. */
    private recycle(slotIndex: number): void {
        const slot = this.slots[slotIndex];
        const child = slot.child;
        slot.child = undefined;
        slot.loaded.clear();
        child?.kill('SIGKILL');
    }

    private onWorkerGone(slotIndex: number, child: ChildProcess, reason: string): void {
        const slot = this.slots[slotIndex];
        if (slot.child === child) {
            slot.child = undefined;
            slot.loaded.clear();
        }
        for (const op of [...this.pendingOps.values()]) {
            if (op.child === child) {
                this.settleOp(op, false, new Error(reason));
            }
        }
        for (const load of [...this.pendingLoads.values()]) {
            if (load.child === child) {
                clearTimeout(load.timer);
                this.pendingLoads.delete(load.connectorId);
                load.reject(new Error(reason));
            }
        }
        this.syncRef(child);
    }
}
