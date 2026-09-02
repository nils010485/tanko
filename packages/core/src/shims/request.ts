/**
 * Headless replacement for Engine.Request.
 *
 * The legacy Request drives hidden Electron BrowserWindows (fetchUI /
 * fetchBrowser) for sites that need JavaScript. In headless mode we emulate
 * this with:
 *  - plain HTTP fetch (undici via node:fetch) with transformed x-* headers
 *  - an isolated evaluation process where the fetched HTML is parsed with
 *    linkedom and inline <script> contents + the connector's injection
 *    script are evaluated (see shims/evaluate.ts / evaluate-child.ts)
 */
import { CookieJar } from 'tough-cookie';
import { browserEnabled, getPageHTML, isAntiBotShell } from './browser.js';
import { evaluateIsolated } from './evaluate.js';
import type { WireRequest, WireResponse } from './evaluate-child.js';

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
        return evaluateIsolated({ url, html, script, timeoutMs, inlineTimeout: Math.min(timeoutMs, 10000), userAgent: this.userAgent }, request =>
            this.fetchSandboxed(url, request)
        );
    }

    /**
     * Host-side transport for the sandbox: re-materializes the plain-wire
     * request the child proxied over IPC and runs it through the shared
     * per-host gate + session fetch (cookies, header transforms, backoffs).
     */
    private async fetchSandboxed(pageUrl: string, wire: WireRequest): Promise<WireResponse> {
        const headers = new Headers(wire.headers);
        if (!headers.has('x-referer')) {
            headers.set('x-referer', pageUrl);
        }
        const request = new Request(wire.url, { method: wire.method, headers, body: wire.bodyB64 ? Buffer.from(wire.bodyB64, 'base64') : undefined });
        const response = await this.gate.run(wire.url, () => this.fetch(request, wire.timeoutMs));
        return { status: response.status, headers: [...response.headers.entries()], bodyB64: Buffer.from(await response.arrayBuffer()).toString('base64') };
    }
}
