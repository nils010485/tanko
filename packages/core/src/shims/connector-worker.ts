/**
 * Legacy connector worker: a whole HakuNeko connector runs here, off the host
 * event loop, because its list operations parse HTML synchronously
 * (Connector.createDOM -> linkedom) and a multi-MB catalog blocks the server
 * for seconds.
 *
 * Dual-purpose like evaluate-child.ts: spawned when TANKO_CONNECTOR_WORKER=1,
 * otherwise importable for its IPC types only (importing this module on the
 * host runs nothing).
 *
 * Invariants:
 *  - the worker holds no session state: cookies, header transforms, the
 *    per-host gate and backoffs stay on the host, every request is an IPC
 *    round-trip (WireRequest/WireResponse);
 *  - the worker IS the isolation boundary, so page scripts are evaluated in
 *    this process (TANKO_EVAL_INPROCESS=1) instead of forking a nested child;
 *  - Chromium stays on the host: anti-bot rendering is a 'render' round-trip.
 */
import { pathToFileURL } from 'node:url';
import type { EngineContext } from '../engine.js';
import type { LegacyChapter, LegacyConnector, LegacyManga } from '../legacy-types.js';
import { searchLegacyMangas } from '../sources/legacy-search.js';
import { currentAbortSignal, withAbortScope } from './abort-scope.js';
import { isAntiBotShell } from './browser.js';
import { evaluateIsolated } from './evaluate.js';
import type { FetchVia, WireRequest, WireResponse } from './evaluate-child.js';
import { installGlobals } from './globals.js';

export interface RenderOptions {
    timeoutMs: number;
}

export type RenderResult = { html: string; finalUrl: string };

/** Host -> worker. */
export type ConnectorCommand =
    | { type: 'load'; connectorId: string; filePath: string; userAgent: string }
    | { type: 'op'; opId: number; connectorId: string; method: string; args: unknown[] }
    | { type: 'cancel'; opId: number }
    | { type: 'fetch-result'; reqId: number; response: WireResponse }
    | { type: 'fetch-error'; reqId: number; message: string }
    | { type: 'render-result'; reqId: number; html: string; finalUrl: string }
    | { type: 'render-error'; reqId: number; message: string };

/** Worker -> host. */
export type ConnectorEvent =
    | { type: 'ready' }
    | { type: 'loaded'; connectorId: string; ok: true }
    | { type: 'loaded'; connectorId: string; ok: false; error: string }
    | { type: 'op-result'; opId: number; ok: true; value: unknown }
    | { type: 'op-result'; opId: number; ok: false; error: string }
    | { type: 'fetch'; reqId: number; request: WireRequest }
    | { type: 'render'; reqId: number; url: string; opts: RenderOptions };

/** Default budget of a single proxied request (matches HeadlessRequest.fetch). */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** The parent may drop the request (op cancelled, worker recycled): stop waiting for it. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(abortReason(signal));
    }
    const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true });
    });
    return Promise.race([promise, aborted]);
}

/** IPC values must be structured-cloneable; a non-cloneable result is a real failure, not silently coerced. */
function transferable(value: unknown): unknown {
    return structuredClone(value);
}

function startConnectorWorker(): void {
    // the pool forks this entry with a minimal env (no host secrets/proxies);
    // must be set before any connector code runs: page scripts are evaluated
    // in this process, a nested fork would escape the worker boundary
    process.env.TANKO_EVAL_INPROCESS = '1';

    installGlobals();

    type SendCallback = (error: Error | null) => void;
    const send = (message: ConnectorEvent, onError?: SendCallback): void => {
        process.send?.(message, undefined, undefined, error => onError?.(error ?? null));
    };

    const replies = new Map<number, Reply>();
    let nextRequestId = 1;

    const ask = <T>(payload: { type: 'fetch'; request: WireRequest } | { type: 'render'; url: string; opts: RenderOptions }): Promise<T> => {
        const reqId = nextRequestId++;
        return new Promise<T>((resolve, reject) => {
            replies.set(reqId, { resolve: value => resolve(value as T), reject });
            send({ ...payload, reqId }, error => {
                if (error) {
                    replies.delete(reqId);
                    reject(error);
                }
            });
        });
    };

    const settleReply = (reqId: number, ok: boolean, value: unknown): void => {
        const reply = replies.get(reqId);
        if (!reply) {
            return;
        }
        replies.delete(reqId);
        if (ok) {
            reply.resolve(value);
        } else {
            reply.reject(new Error(String(value)));
        }
    };

    // the host owns the session: this side only ships plain-wire requests
    const wireRequest = async (request: WireRequest): Promise<WireResponse> => {
        const answer = ask<WireResponse>({ type: 'fetch', request });
        const signal = currentAbortSignal();
        return signal ? await raceAbort(answer, signal) : await answer;
    };

    const responseOf = async (request: Request, timeoutMs: number): Promise<{ response: Response; url: string }> => {
        const bodyB64 = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer()).toString('base64');
        const wire = await wireRequest({ url: request.url, method: request.method, headers: [...request.headers.entries()], bodyB64, timeoutMs });
        const nullBody = wire.status === 204 || wire.status === 205 || wire.status === 304;
        const response = new Response(nullBody ? null : Buffer.from(wire.bodyB64, 'base64'), { status: wire.status, headers: wire.headers });
        // a Response built from a buffer carries no url: the host reports the redirect target
        return { response, url: wire.url || request.url };
    };

    const fetchOf = async (input: RequestInfo | URL, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): Promise<Response> =>
        (await responseOf(input instanceof Request ? input : new Request(input), timeoutMs)).response;

    // every connector fetch (fetchDOM, fetchJSON, fetchUI) lands here and
    // leaves the process: the host owns the session and the network policy
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        fetchOf(input instanceof Request && !init ? input : new Request(input, init));

    let sessionUserAgent = '';

    const renderOf = async (url: string, timeoutMs: number): Promise<RenderResult> => {
        const answer = ask<RenderResult>({ type: 'render', url, opts: { timeoutMs } });
        const signal = currentAbortSignal();
        return signal ? await raceAbort(answer, signal) : await answer;
    };

    // emulates the legacy BrowserWindow: plain HTTP first, real browser only
    // for an anti-bot shell (the host decides - Chromium never runs here)
    const fetchUI = async (input: RequestInfo | URL, script?: string, timeout = DEFAULT_FETCH_TIMEOUT_MS): Promise<unknown> => {
        const request = input instanceof Request ? input : new Request(input);
        const answer = await responseOf(request, timeout);
        let html = await answer.response.text();
        let finalUrl = answer.url;
        if (isAntiBotShell(html, answer.response.status)) {
            const rendered = await renderOf(finalUrl, Math.min(timeout, 30_000)).catch(() => undefined);
            if (rendered && !isAntiBotShell(rendered.html)) {
                html = rendered.html;
                finalUrl = rendered.finalUrl;
            }
        }
        if (!script) {
            return undefined;
        }
        const via: FetchVia = wire => wireRequest(wire);
        return evaluateIsolated(
            { url: finalUrl, html, script, timeoutMs: timeout, inlineTimeout: Math.min(timeout, 10_000), userAgent: sessionUserAgent },
            via
        );
    };

    const engineRequest = {
        fetch: (input: RequestInfo | URL, timeout?: number) => fetchOf(input, timeout),
        fetchUI,
        fetchBrowser: (input: RequestInfo | URL, _preloadScript: unknown, script: string, _preferences?: unknown, timeout?: number) =>
            fetchUI(input, script, timeout),
        fetchJapscan: () => Promise.reject(new Error('fetchJapscan is not supported in headless mode'))
    };

    // connectors read Engine.Settings entries ({ value }) for tuning only, and
    // never touch Engine.Storage during list operations (that is drive-side)
    const settings = new Proxy({ save: () => undefined, load: () => undefined } as Record<string, unknown>, {
        get: (target, key) => (typeof key === 'string' && !(key in target) ? { value: undefined } : Reflect.get(target, key))
    });
    const storage = {
        loadMangaList: async () => [],
        saveMangaList: async () => undefined,
        getExistingMangaTitles: async () => []
    };
    globalThis.Engine = {
        Settings: settings,
        Storage: storage,
        Request: engineRequest,
        Blacklist: { patterns: [] },
        ComicInfoGenerator: { createComicInfoXML: () => '' }
    } as unknown as EngineContext;

    // a connector keeps its state (cookies handled host-side, caches, locks)
    // for the lifetime of the worker: reloading it would lose that state
    const connectors = new Map<string, LegacyConnector>();
    const opScopes = new Map<number, AbortController>();

    const load = async (message: { connectorId: string; filePath: string; userAgent: string }): Promise<void> => {
        if (connectors.has(message.connectorId)) {
            send({ type: 'loaded', connectorId: message.connectorId, ok: true });
            return;
        }
        try {
            sessionUserAgent = message.userAgent;
            const module = await import(pathToFileURL(message.filePath).href);
            const Connector = module.default as new () => LegacyConnector;
            connectors.set(message.connectorId, new Connector());
            send({ type: 'loaded', connectorId: message.connectorId, ok: true });
        } catch (error) {
            send({ type: 'loaded', connectorId: message.connectorId, ok: false, error: errorMessage(error) });
        }
    };

    const promisify = <T>(invoke: (callback: (error: unknown, result?: T) => void) => void): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            invoke((error, result) => {
                if (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                } else {
                    resolve(result as T);
                }
            });
        });

    const toLegacyManga = (connector: LegacyConnector, value: unknown): LegacyManga => {
        const manga = value as LegacyManga;
        return { connector, id: manga.id, title: manga.title };
    };

    const toLegacyChapter = (connector: LegacyConnector, manga: unknown, value: unknown): LegacyChapter => {
        const chapter = value as LegacyChapter;
        return { manga: toLegacyManga(connector, manga), id: chapter.id, title: chapter.title, language: chapter.language };
    };

    const mangaInfo = (manga: LegacyManga): { id: string; title: string } => ({ id: manga.id, title: manga.title });

    const searchMangas = async (connector: LegacyConnector, query: string): Promise<Array<{ id: string; title: string }>> => {
        const mangas = await searchLegacyMangas(connector, query, () => promisify<LegacyManga[] | undefined>(callback => connector._getMangaList(callback)));
        return mangas.map(mangaInfo);
    };

    const runMethod = async (connector: LegacyConnector, method: string, args: unknown[]): Promise<unknown> => {
        switch (method) {
            case 'initialize':
                await connector.initialize();
                return { initialized: connector.initialized === true };
            case 'searchMangas':
                await connector.initialize();
                return await searchMangas(connector, String(args[0] ?? ''));
            case 'getMangaList': {
                // the raw catalog crawl, without the search page shortcut: the health
                // check probes the same operation the list views rely on
                await connector.initialize();
                const mangas = await promisify<LegacyManga[] | undefined>(callback => connector._getMangaList(callback));
                return (mangas || []).map(mangaInfo);
            }
            case 'getChapters': {
                await connector.initialize();
                const chapters = await promisify<LegacyChapter[] | undefined>(callback =>
                    connector._getChapterList(toLegacyManga(connector, args[0]), callback)
                );
                return (chapters || []).map(chapter => ({ id: chapter.id, title: chapter.title, language: chapter.language }));
            }
            case 'getPages':
                await connector.initialize();
                return await promisify<unknown>(callback =>
                    connector._getPageList(toLegacyManga(connector, args[0]), toLegacyChapter(connector, args[0], args[1]), callback)
                );
            case 'handleConnectorURI':
                return await connector.handleConnectorURI(new URL(String(args[0])));
            default:
                throw new Error(`unsupported connector method "${method}"`);
        }
    };

    const runOp = async (message: { opId: number; connectorId: string; method: string; args: unknown[] }): Promise<void> => {
        try {
            const connector = connectors.get(message.connectorId);
            if (!connector) {
                throw new Error(`connector "${message.connectorId}" is not loaded in this worker`);
            }
            // the op scope aborts every fetch it started: 'cancel' then stops
            // the connector's crawl without waiting for its own timeouts
            const value = await withAbortScope(scope => {
                opScopes.set(message.opId, scope);
                return raceAbort(runMethod(connector, message.method, message.args), scope.signal);
            });
            send({ type: 'op-result', opId: message.opId, ok: true, value: transferable(value) });
        } catch (error) {
            send({ type: 'op-result', opId: message.opId, ok: false, error: errorMessage(error) });
        } finally {
            opScopes.delete(message.opId);
        }
    };

    process.on('message', (message: ConnectorCommand) => {
        switch (message.type) {
            case 'fetch-result':
                settleReply(message.reqId, true, message.response);
                return;
            case 'fetch-error':
                settleReply(message.reqId, false, message.message);
                return;
            case 'render-result':
                settleReply(message.reqId, true, { html: message.html, finalUrl: message.finalUrl });
                return;
            case 'render-error':
                settleReply(message.reqId, false, message.message);
                return;
            case 'load':
                void load(message);
                return;
            case 'op':
                void runOp(message);
                return;
            case 'cancel':
                opScopes.get(message.opId)?.abort(new Error('operation cancelled'));
                return;
        }
    });

    // the host owns the lifecycle: no IPC channel means no supervisor left
    process.on('disconnect', () => process.exit(0));
    send({ type: 'ready' });
}

if (process.env.TANKO_CONNECTOR_WORKER === '1' && typeof process.send === 'function') {
    startConnectorWorker();
}
