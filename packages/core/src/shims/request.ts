/**
 * Headless replacement for Engine.Request.
 *
 * The legacy Request drives hidden Electron BrowserWindows (fetchUI /
 * fetchBrowser) for sites that need JavaScript. In headless mode we emulate
 * this with:
 *  - plain HTTP fetch (undici via node:fetch) with transformed x-* headers
 *  - a shared tough-cookie jar (session-like behaviour)
 *  - a vm sandbox where the fetched HTML is parsed with linkedom and inline
 *    <script> contents + the connector's injection script are evaluated
 */
import vm from 'node:vm';
import { CookieJar } from 'tough-cookie';
import { browserEnabled, getPageHTML, isAntiBotShell } from './browser.js';
import { parseDocument } from './dom.js';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
];

export function randomUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/** Minimal shape of the request objects the legacy engine passes around. */
interface LegacyRequest {
    url: string;
    method?: string;
    headers: Headers;
    /** Undocumented legacy contract: POST bodies are stashed on the request object. */
    _body?: BodyInit;
}

/**
 * Apply the same header transformations that the legacy electron main
 * process applied in onBeforeSendHeadersHandler.
 */
export function prepareHeaders(request: LegacyRequest, defaultUserAgent: string): { headers: Headers; extraCookie?: string } {
    const headers = new Headers();
    for (const [name, value] of request.headers.entries()) {
        headers.set(name, value);
    }

    // x-* headers carry the real destination values; read them before dropping
    const userAgent = headers.get('x-user-agent') || defaultUserAgent;
    const extraCookie = headers.get('x-cookie') || undefined;
    const forwarded: Array<[string, string | null]> = [
        ['Referer', headers.get('x-referer')],
        ['Origin', headers.get('x-origin')],
        ['Sec-Fetch-Dest', headers.get('x-sec-fetch-dest')],
        ['Sec-Fetch-Mode', headers.get('x-sec-fetch-mode')],
        ['Sec-Fetch-Site', headers.get('x-sec-fetch-site')]
    ];

    for (const name of [...headers.keys()]) {
        if (name.toLowerCase().startsWith('x-')) {
            headers.delete(name);
        }
    }

    headers.set('User-Agent', userAgent);
    for (const [name, value] of forwarded) {
        if (value) {
            headers.set(name, value);
        }
    }

    const url = new URL(request.url);
    // image requests should only accept images (imgur & co.)
    if (/i\.imgur\.com/i.test(url.hostname) || /\.(jpg|jpeg|png|gif|webp)/i.test(url.pathname)) {
        headers.set('Accept', 'image/webp,image/apng,image/*,*/*');
    }

    return { headers, extraCookie };
}

/**
 * Browsers cap connections per host (~6); a vm script firing hundreds of
 * parallel requests (e.g. MangaHere's chapterfun.ashx for every page of a
 * chapter) trips server-side throttling that answers 200 with empty bodies.
 * Gate sandboxed requests to a browser-like per-host concurrency.
 */
/** Attempts before giving up on an endpoint that keeps answering 200 with an empty body. */
const AJAX_EMPTY_ATTEMPTS = 3;
/** Per-attempt cap so ajax retries (backoff included) fit the caller's overall timeout. */
const AJAX_ATTEMPT_TIMEOUT_MS = 15000;
const MAX_IN_FLIGHT_PER_HOST = 5;

/** Attempts (total) for rate-limited responses before giving up. */
const RATE_LIMIT_ATTEMPTS = 3;
/** Upper bound honoring a Retry-After hint — longer hints still give up. */
const MAX_RETRY_DELAY_MS = 15000;
/** Fallback wait between attempts when the server doesn't say how long. */
const RETRY_BACKOFF_MS = 1000;

/**
 * Parse the Retry-After header (delay-seconds or HTTP-date) into a wait in
 * milliseconds, clamped to a sane maximum. Returns undefined when absent or
 * unparseable.
 */
export function retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
        return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(header);
    return Number.isNaN(date) ? undefined : Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

class HostGate {
    private inFlight = new Map<string, number>();
    private waiters = new Map<string, Array<() => void>>();

    async run<T>(url: string, task: () => Promise<T>): Promise<T> {
        const host = new URL(url).hostname;
        await this.acquire(host);
        try {
            return await task();
        } finally {
            this.release(host);
        }
    }

    private async acquire(host: string): Promise<void> {
        const current = this.inFlight.get(host) ?? 0;
        if (current < MAX_IN_FLIGHT_PER_HOST) {
            this.inFlight.set(host, current + 1);
            return;
        }
        await new Promise<void>(resolve => {
            const queue = this.waiters.get(host);
            if (queue) {
                queue.push(resolve);
            } else {
                this.waiters.set(host, [resolve]);
            }
        });
    }

    private release(host: string): void {
        const next = this.waiters.get(host)?.shift();
        if (next) {
            next(); // hand the slot over to the next queued request
            return;
        }
        this.inFlight.set(host, Math.max(0, (this.inFlight.get(host) ?? 1) - 1));
    }
}

export class HeadlessRequest {
    userAgent: string;
    jar: CookieJar;
    /** Shared so parallel evaluations (download queue) hit one global per-host cap. */
    private gate = new HostGate();
    /**
     * Hosts that answered 429/503+Retry-After: no request leaves before the
     * announced delay, so parallel callers don't each collect their own 429.
     */
    private blockedUntil = new Map<string, number>();

    constructor() {
        this.userAgent = randomUserAgent();
        this.jar = new CookieJar();
    }

    /**
     * Perform an HTTP(S) request with session cookies and header transforms.
     * Rate-limited (429) responses — and 503 announcing a Retry-After — are
     * retried with the announced delay (bounded) within the caller's timeout.
     */
    async fetch(request: LegacyRequest | string, timeout = 60000): Promise<Response> {
        const legacyRequest = typeof request === 'string' ? { url: request, headers: new Headers() } : request;
        const url = legacyRequest.url;
        const deadline = Date.now() + timeout;
        await this.awaitHostBackoff(url, deadline);

        let response: Response | undefined;
        for (let attempt = 0; ; attempt++) {
            // re-prepare per attempt: a throttling response may have set cookies
            const { headers, extraCookie } = prepareHeaders(legacyRequest, this.userAgent);
            let cookieHeader = await this.jar.getCookieString(url).catch(() => '');
            if (extraCookie) {
                cookieHeader = cookieHeader ? `${cookieHeader}; ${extraCookie}` : extraCookie;
            }
            if (cookieHeader) {
                headers.set('Cookie', cookieHeader);
            }

            response = await fetch(url, {
                method: legacyRequest.method || 'GET',
                headers,
                body: legacyRequest.method === 'POST' ? legacyRequest._body : undefined,
                redirect: 'follow',
                signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
            });

            for (const setCookie of response.headers.getSetCookie?.() || []) {
                await this.jar.setCookie(setCookie, response.url || url).catch(() => undefined);
            }

            const retryable = response.status === 429 || (response.status === 503 && response.headers.has('retry-after'));
            const wait = retryAfterMs(response) ?? RETRY_BACKOFF_MS * (attempt + 1);
            if (retryable) {
                this.markHostBackoff(url, wait);
            }
            if (!retryable || attempt === RATE_LIMIT_ATTEMPTS - 1 || Date.now() + wait >= deadline) {
                return response;
            }
            await response.body?.cancel().catch(() => undefined); // free the socket before idling
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }

    /**
     * Wait out a host-wide rate-limit block recorded by an earlier request.
     * The wait is clamped to the caller's deadline: the fetch signal then
     * decides what still fits in the budget.
     */
    private async awaitHostBackoff(url: string, deadline: number): Promise<void> {
        const host = new URL(url).hostname;
        const until = this.blockedUntil.get(host);
        if (!until || until <= Date.now()) {
            this.blockedUntil.delete(host); // no-op for absent hosts
            return;
        }
        const wait = Math.max(0, Math.min(until, deadline) - Date.now());
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }

    /**
     * Publish a 429/503 wait to every future request on this host (only ever
     * extends the block); expired entries are pruned along the way.
     */
    private markHostBackoff(url: string, waitMs: number): void {
        const host = new URL(url).hostname;
        const now = Date.now();
        const until = now + waitMs;
        if (until > (this.blockedUntil.get(host) ?? 0)) {
            this.blockedUntil.set(host, until);
        }
        for (const [blockedHost, expires] of this.blockedUntil) {
            if (expires <= now) {
                this.blockedUntil.delete(blockedHost);
            }
        }
    }

    /**
     * Emulated BrowserWindow: fetch the page, evaluate inline scripts and the
     * given injection script in a sandboxed DOM.
     */
    async fetchUI(request: LegacyRequest | string, injectionScript?: string, timeout = 60000): Promise<unknown> {
        const url = typeof request === 'string' ? request : request.url;
        const response = await this.fetch(request, timeout);
        let html = await response.text();
        let finalUrl = response.url || url;
        // anti-bot fallback: render in a real headless Chromium when plain HTTP
        // returns a JS/anti-bot shell (Cloudflare, JS redirect, "Loading...")
        if (isAntiBotShell(html, response.status) && browserEnabled()) {
            try {
                const rendered = await getPageHTML(finalUrl, { userAgent: this.userAgent, timeoutMs: Math.min(timeout, 30000) });
                if (!isAntiBotShell(rendered.html)) {
                    html = rendered.html;
                    finalUrl = rendered.finalUrl;
                }
            } catch {
                /* keep the HTTP html on browser failure */
            }
        }
        if (!injectionScript) {
            return undefined;
        }
        return this._evaluateInPage(finalUrl, html, injectionScript, timeout);
    }

    /**
     * Same emulation as fetchUI (preload scripts are ignored headless).
     */
    async fetchBrowser(
        request: LegacyRequest | string,
        _preloadScript: unknown,
        runtimeScript: string,
        _preferences?: unknown,
        timeout = 60000
    ): Promise<unknown> {
        return this.fetchUI(request, runtimeScript, timeout);
    }

    async fetchJapscan(): Promise<never> {
        throw new Error('fetchJapscan is not supported in headless mode');
    }

    _evaluateInPage(url: string, html: string, script: string, timeout?: number): Promise<unknown> {
        const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : 60000;
        const inlineTimeout = Math.min(timeoutMs, 10000);
        const document = parseDocument(html);
        const location = new URL(url);

        // page scripts schedule timers that may throw later — a raw setTimeout
        // callback escapes the inline try/catch and kills the whole process
        const safeSetTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
            setTimeout(() => {
                try {
                    callback(...args);
                } catch {
                    /* hostile page script, ignore */
                }
            }, ms);
        // intervals are tracked so they can be cleared once the evaluation
        // settles (the legacy BrowserWindow was destroyed after each script)
        const trackedIntervals = new Set<ReturnType<typeof setInterval>>();
        const safeSetInterval = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            const id = setInterval(() => {
                try {
                    callback(...args);
                } catch {
                    /* hostile page script, ignore */
                }
            }, ms);
            trackedIntervals.add(id);
            return id;
        };
        const gate = this.gate;
        const sandbox: Record<string, unknown> = {
            console,
            setTimeout: safeSetTimeout,
            clearTimeout,
            setInterval: safeSetInterval,
            clearInterval,
            URL,
            URLSearchParams,
            TextDecoder,
            TextEncoder,
            atob,
            btoa,
            JSON,
            Math,
            Date,
            RegExp,
            Promise,
            Object,
            Array,
            String,
            Number,
            Boolean,
            Symbol,
            Map,
            Set,
            WeakMap,
            Error,
            TypeError,
            RangeError,
            parseInt,
            parseFloat,
            isNaN,
            decodeURI,
            decodeURIComponent,
            encodeURI,
            encodeURIComponent,
            crypto: globalThis.crypto,
            fetch: (input: Request | string, init?: RequestInit) => {
                const request = typeof input === 'string' ? new Request(new URL(input, location.href).href, init) : input;
                // browsers send the page URL as Referer on every subrequest;
                // hotlink protection (mangahere & co.) rejects without it
                request.headers.set('x-referer', request.headers.get('x-referer') || location.href);
                return gate.run(request.url, () => this.fetch(request));
            },
            Headers,
            Request,
            Response,
            AbortController,
            AbortSignal,
            CustomEvent,
            Event,
            EventTarget,
            document,
            navigator: { userAgent: this.userAgent },
            location
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
            // budget — orphaned fetches would keep gate slots and hammer the host
            // after the evaluation's race already reported a timeout
            const deadline = Date.now() + timeoutMs;
            let text = '';
            let response: Response | undefined;
            let networkError: unknown;
            try {
                for (let attempt = 1; ; attempt++) {
                    const remaining = deadline - Date.now();
                    if (remaining <= 0) {
                        break;
                    }
                    response = await gate.run(target.href, () =>
                        this.fetch({ url: target.href, method, headers, _body: body }, Math.min(remaining, AJAX_ATTEMPT_TIMEOUT_MS))
                    );
                    if (!response.ok) {
                        break;
                    }
                    text = await response.text();
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
            if (networkError !== undefined || (response !== undefined && !response.ok)) {
                const error = networkError instanceof Error ? networkError : new Error(String(networkError ?? `HTTP ${response?.status}`));
                options.error?.(undefined, 'error', error);
                // like jQuery, the jqXHR promise rejects on transport/HTTP errors
                throw error;
            }
            // jqXHR-like third argument (the real response body is already consumed)
            const jqXHR = response && {
                status: response.status,
                responseText: text,
                getResponseHeader: (name: string) => response.headers.get(name)
            };
            options.success?.(text, 'success', jqXHR);
            return text;
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
                throw error;
            }
            result = vm.runInContext(`(function(){${expression}})()`, context, { timeout: timeoutMs });
        }
        // the snippet may resolve a promise that never settles (a page script
        // waiting on browser-only APIs) — race it so the caller is never stuck
        const settled = Promise.resolve(result);
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('script evaluation timed out')), timeoutMs);
            timer.unref?.();
        });
        return Promise.race([settled, expired]).finally(() => {
            clearTimeout(timer);
            for (const id of trackedIntervals) {
                clearInterval(id);
            }
        });
    }
}
