/**
 * Page-script evaluation sandbox, isolated from the host process.
 *
 * This module is dual-purpose:
 *  - spawned as a dedicated child process (TANKO_EVAL_CHILD=1): the parent
 *    proxies every sandbox fetch over IPC, so page scripts never touch the
 *    session, the cookie jar or the host network stack directly;
 *  - imported as a fallback when the child cannot be spawned.
 *
 * Containment layers (why this is not just `vm`):
 *  1. No ECMAScript intrinsics of the HOST realm are passed into the vm
 *     context (no Promise/Object/JSON/…). A fresh context realm carries its
 *     own intrinsics, which closes the classic
 *     `Promise.constructor("return process")()` escape.
 *  2. The Web APIs a page needs (document, timers, fetch, Request/Response…)
 *     are outer-realm objects and stay prototype-chain bridges — they can
 *     never be made safe inside one process. The child therefore runs under
 *     the Node permission model (`--permission`, read-only allow-list) with a
 *     wiped environment and is killed after a single evaluation: an escaped
 *     script reaches a bare, disposable process instead of the server.
 */
import vm from 'node:vm';
import { parseDocument } from './dom.js';

export interface EvalPayload {
    url: string;
    html: string;
    script: string;
    timeoutMs: number;
    inlineTimeout: number;
    userAgent: string;
}

/** Plain-wire request/response so values can cross the IPC channel. */
export interface WireRequest {
    url: string;
    method: string;
    headers: Array<[string, string]>;
    bodyB64?: string;
    /** Per-attempt budget the parent applies to its own fetch. */
    timeoutMs?: number;
}

export interface WireResponse {
    status: number;
    headers: Array<[string, string]>;
    bodyB64: string;
}
export type FetchVia = (request: WireRequest) => Promise<WireResponse>;

export type EvalOutcome = { ok: true; value: unknown } | { ok: false; error: string };

type ParentToChild =
    | { type: 'evaluate'; payload: EvalPayload }
    | { type: 'fetch-result'; reqId: number; response: WireResponse }
    | { type: 'fetch-error'; reqId: number; message: string };

/** Attempts before giving up on an endpoint that keeps answering 200 with an empty body. */
const AJAX_EMPTY_ATTEMPTS = 3;
/** Per-attempt cap so ajax retries (backoff included) fit the caller's overall timeout. */
const AJAX_ATTEMPT_TIMEOUT_MS = 15000;
/** Default budget of a sandbox fetch (matches HeadlessRequest.fetch's own default). */
const SANDBOX_FETCH_TIMEOUT_MS = 60_000;

/**
 * Evaluate the page's inline scripts then the connector snippet, in a context
 * that only exposes what a browser page would have. Never throws: the outcome
 * (or the failure reason, e.g. the evaluation timeout) is returned.
 */
export async function runPageEvaluation(payload: EvalPayload, fetchVia: FetchVia): Promise<EvalOutcome> {
    const { url, html, script, timeoutMs, inlineTimeout, userAgent } = payload;
    const document = parseDocument(html);
    const location = new URL(url);
    const deadline = Date.now() + timeoutMs;

    // page scripts schedule timers that may throw later — a raw callback must
    // never escape its try/catch (it would kill the child for nothing) and is
    // tracked so nothing survives the evaluation (the legacy BrowserWindow was
    // destroyed after each script)
    const trackedTimers = new Set<ReturnType<typeof setTimeout>>();
    const track = (id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
        id.unref?.();
        trackedTimers.add(id);
        return id;
    };
    const guard = (callback: (...args: unknown[]) => void, args: unknown[]) => {
        try {
            callback(...args);
        } catch {
            /* hostile page script, ignore */
        }
    };
    const safeSetTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => track(setTimeout(() => guard(callback, args), ms));
    const safeSetInterval = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => track(setInterval(() => guard(callback, args), ms));

    // the parent owns the session: cookies, header transforms (x-*), per-host
    // gate/backoff — this side only sends a plain-wire request
    const wire = async (request: WireRequest): Promise<Response> => {
        // never hand out a zero budget: the parent's own deadline has to stay positive
        const remaining = Math.max(1, deadline - Date.now());
        const response = await fetchVia({
            ...request,
            timeoutMs: Math.min(request.timeoutMs ?? SANDBOX_FETCH_TIMEOUT_MS, remaining)
        });
        return new Response(Buffer.from(response.bodyB64, 'base64'), { status: response.status, headers: response.headers });
    };

    const sandboxFetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
        const request = typeof input === 'string' ? new Request(new URL(input, location.href).href, init) : input;
        // browsers send the page URL as Referer on every subrequest;
        // hotlink protection (mangahere & co.) rejects without it
        if (!request.headers.has('x-referer')) {
            request.headers.set('x-referer', location.href);
        }
        const bodyB64 = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer()).toString('base64');
        return wire({ url: request.url, method: request.method, headers: [...request.headers.entries()], bodyB64 });
    };

    // jQuery is always loaded from an external <script src> which we never
    // fetch — connectors like MangaHere/MangaFox rely on $.ajax, so provide
    // a minimal promise-based subset (inline page scripts may overwrite it)
    const ajax = async (settings: unknown) => {
        const options = (typeof settings === 'string' ? { url: settings } : (settings ?? {})) as {
            type?: unknown;
            method?: unknown;
            url?: unknown;
            data?: unknown;
            headers?: HeadersInit;
            error?: (jqXHR: undefined, textStatus: string, error: Error) => void;
            success?: (data: string, textStatus: string, jqXHR: unknown) => void;
        };
        const target = new URL(String(options.url ?? location.href), location.href);
        const method = String(options.type ?? options.method ?? 'GET').toUpperCase();
        const data = options.data;
        let body: string | undefined;
        if (data !== undefined && data !== null) {
            if (method === 'GET') {
                const params = new URLSearchParams(target.search);
                // data may be a plain object or a pre-serialized query string
                const entries = typeof data === 'string' ? new URLSearchParams(data) : Object.entries(data as Record<string, unknown>);
                for (const [key, value] of entries) {
                    params.append(key, String(value));
                }
                target.search = params.toString();
            } else {
                body = typeof data === 'string' ? data : JSON.stringify(data);
            }
        }
        const headers = new Headers(options.headers);
        // jQuery/XHR always sends the page URL as Referer — sites with
        // hotlink protection answer missing-referer requests with 200 + empty body
        if (!headers.has('Referer') && !headers.has('x-referer')) {
            headers.set('x-referer', location.href);
        }
        if (body !== undefined && !headers.has('Content-Type')) {
            headers.set('Content-Type', typeof data === 'string' ? 'application/x-www-form-urlencoded' : 'application/json');
        }
        // per-attempt timeouts + retry backoffs must fit the caller's overall
        // budget — orphaned fetches would hold gate slots and hammer the host
        // after the evaluation has already timed out
        let text = '';
        let wireResponse: WireResponse | undefined;
        let networkError: unknown;
        try {
            for (let attempt = 1; ; attempt++) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                    break;
                }
                wireResponse = await fetchVia({
                    url: target.href,
                    method,
                    headers: [...headers.entries()],
                    bodyB64: body === undefined || method === 'GET' ? undefined : Buffer.from(body).toString('base64'),
                    timeoutMs: Math.min(remaining, AJAX_ATTEMPT_TIMEOUT_MS)
                });
                if (wireResponse.status < 200 || wireResponse.status >= 300) {
                    break;
                }
                text = Buffer.from(wireResponse.bodyB64, 'base64').toString('utf8');
                // some endpoints (e.g. mangahere chapterfun.ashx) intermittently
                // answer 200 with an empty body — retry with backoff instead of
                // returning junk the connector's eval() cannot use
                if (text.trim() || attempt === AJAX_EMPTY_ATTEMPTS) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, Math.max(0, deadline - Date.now()))));
            }
        } catch (error) {
            networkError = error;
        }
        if (networkError !== undefined || wireResponse === undefined || wireResponse.status < 200 || wireResponse.status >= 300) {
            const error = networkError instanceof Error ? networkError : new Error(String(networkError ?? `HTTP ${wireResponse?.status ?? 0}`));
            options.error?.(undefined, 'error', error);
            // like jQuery, the jqXHR promise rejects on transport/HTTP errors
            throw error;
        }
        // jqXHR-like third argument (the real response body is already consumed)
        const responseHeaders = new Headers(wireResponse.headers);
        const jqXHR = {
            status: wireResponse.status,
            responseText: text,
            getResponseHeader: (name: string) => responseHeaders.get(name)
        };
        options.success?.(text, 'success', jqXHR);
        return text;
    };

    // no-op facade: page logging is noise, and the host console must stay out
    const safeConsole = Object.fromEntries(
        ['assert', 'clear', 'count', 'debug', 'dir', 'error', 'group', 'groupEnd', 'info', 'log', 'table', 'time', 'timeEnd', 'trace', 'warn'].map(name => [
            name,
            () => undefined
        ])
    );

    // NO host realm intrinsics here (Promise/Object/JSON/…): the context realm
    // already provides its own, and host ones are escape bridges
    const sandbox: Record<string, unknown> = {
        console: safeConsole,
        setTimeout: safeSetTimeout,
        clearTimeout: (id: ReturnType<typeof setTimeout>) => {
            clearTimeout(id);
            trackedTimers.delete(id);
        },
        setInterval: safeSetInterval,
        clearInterval: (id: ReturnType<typeof setInterval>) => {
            clearInterval(id);
            trackedTimers.delete(id);
        },
        URL,
        URLSearchParams,
        TextDecoder,
        TextEncoder,
        atob,
        btoa,
        fetch: sandboxFetch,
        Headers,
        Request,
        Response,
        AbortController,
        AbortSignal,
        CustomEvent,
        Event,
        EventTarget,
        crypto: globalThis.crypto,
        document,
        navigator: { userAgent },
        location
    };
    sandbox.$ = { ajax };
    sandbox.jQuery = sandbox.$;
    // window is the sandbox itself (window.document / window.location land here)
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.top = sandbox;
    sandbox.parent = sandbox;

    const context = vm.createContext(sandbox);

    // Execute inline scripts so site-defined globals (e.g. ts_reader) exist.
    // External scripts (src=...) are skipped.
    for (const element of [...document.querySelectorAll('script')]) {
        const source = element.getAttribute('src');
        const code = element.textContent;
        if (!source && code && code.trim()) {
            try {
                vm.runInContext(code, context, { timeout: inlineTimeout });
            } catch {
                /* page scripts may fail harmlessly (missing browser APIs) */
            }
        }
    }

    // connectors hand us expression snippets that may end with a
    // statement semicolon (« new Promise(...); ») — a naive
    // '(' + script + ')' wrap is then a syntax error
    const expression = script.trim().replace(/;+\s*$/, '');
    let result: unknown;
    try {
        result = vm.runInContext(`(${expression})`, context, { timeout: timeoutMs });
    } catch (error) {
        if (!(error instanceof SyntaxError)) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        try {
            result = vm.runInContext(`(function(){${expression}})()`, context, { timeout: timeoutMs });
        } catch (retryError) {
            return { ok: false, error: retryError instanceof Error ? retryError.message : String(retryError) };
        }
    }
    // the snippet may resolve a promise that never settles (a page script
    // waiting on browser-only APIs) — race it so the child always answers
    const settled = Promise.resolve(result);
    const expired = new Promise<never>((_, reject) => {
        // inline scripts already consumed part of the budget — race on what's left
        const timer = setTimeout(() => reject(new Error('script evaluation timed out')), Math.max(1, deadline - Date.now()));
        timer.unref?.();
    });
    try {
        return { ok: true, value: await Promise.race([settled, expired]) };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        for (const id of trackedTimers) {
            clearTimeout(id); // Node timers: clearTimeout also clears intervals
        }
        trackedTimers.clear();
    }
}

/** IPC values must be structured-cloneable; degrade gracefully instead of hanging. */
function serializeOutcome(outcome: EvalOutcome): EvalOutcome {
    if (!outcome.ok) {
        return outcome;
    }
    try {
        structuredClone(outcome.value);
        return outcome;
    } catch {
        try {
            return { ok: true, value: JSON.parse(JSON.stringify(outcome.value)) };
        } catch {
            return { ok: false, error: 'evaluation result is not transferable' };
        }
    }
}

// ---------------------------------------------------------------------------
// Child entry: one evaluation per process, killed by the parent afterwards.
// The environment is wiped before anything else can read it.
// ---------------------------------------------------------------------------
if (typeof process.send === 'function' && process.env.TANKO_EVAL_CHILD === '1') {
    for (const key of Object.keys(process.env)) {
        delete process.env[key];
    }
    const send: NonNullable<typeof process.send> = process.send.bind(process);
    const pendingFetches = new Map<number, { resolve: (response: WireResponse) => void; reject: (error: Error) => void }>();
    let nextRequestId = 1;
    const finish = (outcome: EvalOutcome) => {
        send({ type: 'result', outcome: serializeOutcome(outcome) }, undefined, undefined, error => {
            if (error) {
                process.exit(1);
            }
        });
        // give the IPC write a moment, then leave no timers behind
        setTimeout(() => process.exit(0), 100).unref?.();
    };
    process.on('message', (message: ParentToChild) => {
        if (message.type === 'fetch-result') {
            pendingFetches.get(message.reqId)?.resolve(message.response);
            pendingFetches.delete(message.reqId);
            return;
        }
        if (message.type === 'fetch-error') {
            pendingFetches.get(message.reqId)?.reject(new Error(message.message));
            pendingFetches.delete(message.reqId);
            return;
        }
        if (message.type !== 'evaluate') {
            return;
        }
        const via: FetchVia = request =>
            new Promise<WireResponse>((resolve, reject) => {
                const reqId = nextRequestId++;
                pendingFetches.set(reqId, { resolve, reject });
                send({ type: 'fetch', reqId, request }, undefined, undefined, error => {
                    if (error) {
                        pendingFetches.delete(reqId);
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                });
            });
        runPageEvaluation(message.payload, via).then(finish, (error: unknown) => finish({ ok: false, error: String(error) }));
    });
    send({ type: 'ready' });
}
