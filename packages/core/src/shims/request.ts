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

    // drop all custom x-* headers
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

export class HeadlessRequest {

    userAgent: string;
    jar: CookieJar;

    constructor() {
        this.userAgent = randomUserAgent();
        this.jar = new CookieJar();
    }

    /**
     * Perform an HTTP(S) request with session cookies and header transforms.
     */
    async fetch(request: any, timeout = 60000): Promise<Response> {
        const url = request.url || String(request);
        const { headers, extraCookie } = prepareHeaders(request, this.userAgent);

        let cookieHeader = await this.jar.getCookieString(url).catch(() => '');
        if (extraCookie) {
            cookieHeader = cookieHeader ? cookieHeader + '; ' + extraCookie : extraCookie;
        }
        if (cookieHeader) {
            headers.set('Cookie', cookieHeader);
        }

        const response = await fetch(url, {
            method: request.method || 'GET',
            headers,
            body: request.method === 'POST' ? request._body : undefined,
            redirect: 'follow',
            signal: AbortSignal.timeout(timeout)
        });

        for (const setCookie of response.headers.getSetCookie?.() || []) {
            await this.jar.setCookie(setCookie, response.url || url).catch(() => undefined);
        }
        return response;
    }

    /**
     * Emulated BrowserWindow: fetch the page, evaluate inline scripts and the
     * given injection script in a sandboxed DOM.
     */
    async fetchUI(request: any, injectionScript?: string, timeout = 60000): Promise<any> {
        const url = request.url || String(request);
        const response = await this.fetch(request, timeout);
        let html = await response.text();
        let finalUrl = response.url || url;
        // anti-bot fallback: render in a real headless Chromium when plain HTTP
        // returns a JS/anti-bot shell (Cloudflare, JS redirect, "Loading...")
        if (isAntiBotShell(html) && browserEnabled()) {
            try {
                const rendered = await getPageHTML(finalUrl, { userAgent: this.userAgent, timeoutMs: Math.min(timeout, 30000) });
                if (!isAntiBotShell(rendered.html)) {
                    html = rendered.html;
                    finalUrl = rendered.finalUrl;
                }
            } catch { /* keep the HTTP html on browser failure */ }
        }
        if (!injectionScript) {
            return undefined;
        }
        return this._evaluateInPage(finalUrl, html, injectionScript, timeout);
    }

    /**
     * Same emulation as fetchUI (preload scripts are ignored headless).
     */
    async fetchBrowser(request: any, preloadScript: any, runtimeScript: string, preferences?: any, timeout = 60000): Promise<any> {
        return this.fetchUI(request, runtimeScript, timeout);
    }

    async fetchJapscan(): Promise<never> {
        throw new Error('fetchJapscan is not supported in headless mode');
    }

    _evaluateInPage(url: string, html: string, script: string, timeout?: number): Promise<any> {
        const timeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : 60000;
        const inlineTimeout = Math.min(timeoutMs, 10000);
        const document = parseDocument(html);
        const location = new URL(url);

        // page scripts schedule timers that may throw later — a raw setTimeout
        // callback escapes the inline try/catch and kills the whole process
        const safeSetTimeout = (callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
            setTimeout(() => {
                try {
                    callback(...args);
                } catch { /* hostile page script, ignore */ }
            }, ms);
        const safeSetInterval = (callback: (...args: any[]) => void, ms?: number, ...args: any[]) =>
            setInterval(() => {
                try {
                    callback(...args);
                } catch { /* hostile page script, ignore */ }
            }, ms);
        const sandbox: any = {
            console,
            setTimeout: safeSetTimeout, clearTimeout, setInterval: safeSetInterval, clearInterval,
            URL, URLSearchParams, TextDecoder, TextEncoder,
            atob, btoa, JSON, Math, Date, RegExp, Promise,
            Object, Array, String, Number, Boolean, Symbol, Map, Set, WeakMap,
            Error, TypeError, RangeError, parseInt, parseFloat, isNaN,
            decodeURI, decodeURIComponent, encodeURI, encodeURIComponent,
            crypto: globalThis.crypto,
            fetch: (...args: any[]) => this.fetch(typeof args[0] === 'string' ? new Request(args[0], args[1]) : args[0]),
            Headers, Request, Response, AbortController, AbortSignal,
            CustomEvent, Event, EventTarget,
            document,
            navigator: { userAgent: this.userAgent },
            location
        };
        sandbox.window = sandbox;
        sandbox.self = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.top = sandbox;
        sandbox.parent = sandbox;
        sandbox.window.document = document;
        sandbox.window.location = location;

        const context = vm.createContext(sandbox);

        // Execute inline scripts so site-defined globals (e.g. ts_reader) exist.
        // External scripts (src=...) are skipped.
        for (const element of [...document.querySelectorAll('script')]) {
            const source = (element as any).getAttribute('src');
            const code = (element as any).textContent;
            if (!source && code && code.trim()) {
                try {
                    vm.runInContext(code, context, { timeout: inlineTimeout });
                } catch { /* page scripts may fail harmlessly (missing browser APIs) */ }
            }
        }

        // connectors hand us expression snippets that may end with a
        // statement semicolon (« new Promise(...); ») — a naive
        // '(' + script + ')' wrap is then a syntax error
        const expression = script.trim().replace(/;+\s*$/, '');
        let result: unknown;
        try {
            result = vm.runInContext('(' + expression + ')', context, { timeout: timeoutMs });
        } catch (error) {
            if (!(error instanceof SyntaxError)) {
                throw error;
            }
            result = vm.runInContext('(function(){' + expression + '})()', context, { timeout: timeoutMs });
        }
        // the snippet may resolve a promise that never settles (a page script
        // waiting on browser-only APIs) — race it so the caller is never stuck
        const settled = Promise.resolve(result);
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('script evaluation timed out')), timeoutMs);
            timer.unref?.();
        });
        return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
    }
}
