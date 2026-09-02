/**
 * Shared HTTP helpers for native connectors: URL resolution against a base and
 * the plain-fetch -> headless-Chromium fallback every anti-bot-shelled site
 * needs. Keeps the per-connector classes down to their actual scraping logic.
 */

import { browserEnabled, getPageHTML, isAntiBotShell } from '../../shims/browser.js';
import { randomUserAgent, retryAfterMs } from '../../shims/request.js';
import { SourceError } from '../types.js';

/** Resolve href against base, null when href is empty or unparseable. */
export function absoluteUrl(href: string | undefined | null, base: string): string | null {
    if (!href) {
        return null;
    }
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}

const RETRY_ATTEMPTS = 3; // initial try + 2 retries
const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_BASE_DELAY_MS = 2500;

export interface RetryingFetchOptions {
    /** connector id (error attribution) */
    id: string;
    headers?: Record<string, string>;
}

/**
 * Plain GET with the shared retry ladder: 60s timeout, network failures and
 * transient statuses (403/429/5xx, honoring Retry-After) retried with
 * 2500ms×n backoff, permanent client errors failing fast. Single copy —
 * connector-specific behavior (browser escalation, JSON shells) lives in
 * the connectors themselves.
 */
export async function fetchWithRetries(url: string, options: RetryingFetchOptions, attempt = 0): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, {
            headers: options.headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        // network/timeout failure -> transient, retry with backoff
        if (attempt < RETRY_ATTEMPTS - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
            return fetchWithRetries(url, options, attempt + 1);
        }
        throw new SourceError(`GET ${url} failed after retries`, options.id, error);
    }
    // protection/rate-limit responses -> transient, honor Retry-After
    if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < RETRY_ATTEMPTS - 1) {
        await new Promise(resolve => setTimeout(resolve, retryAfterMs(response) ?? RETRY_BASE_DELAY_MS * (attempt + 1)));
        return fetchWithRetries(url, options, attempt + 1);
    }
    if (!response.ok) {
        // permanent client errors (404, ...) -> fail fast, no retry
        throw new SourceError(`GET ${url} returned ${response.status}`, options.id);
    }
    return response;
}

/**
 * Same-origin pin: manga/chapter URLs handed back by the API may be absolute —
 * pin them to the connector's declared origin (plus explicit CDN exceptions)
 * so a crafted id cannot point the scraper (or the headless browser) at
 * internal addresses (SSRF). Relative ids resolve against base as usual.
 */
export function pinToOrigin(url: string, base: string, options?: { id?: string; allowedHosts?: RegExp[] }): string {
    let parsed: URL;
    try {
        parsed = new URL(url, base);
    } catch {
        throw new SourceError(`Invalid URL "${url}"`, options?.id ?? 'unknown');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SourceError(`Blocked non-http(s) URL "${url}"`, options?.id ?? 'unknown');
    }
    const sameOrigin = parsed.origin === new URL(base).origin;
    const cdnOk = options?.allowedHosts?.some(pattern => pattern.test(parsed.hostname)) ?? false;
    if (!sameOrigin && !cdnOk) {
        throw new SourceError(`Blocked cross-origin URL "${parsed.href}" (expected ${new URL(base).origin})`, options?.id ?? 'unknown');
    }
    return parsed.href;
}

export interface NativeTextOptions {
    /** connector id (error attribution) */
    id: string;
    headers?: Record<string, string>;
    /** extra RequestInit (method/body/signal) merged over the defaults */
    init?: RequestInit;
    /** accept the plain response only when the body is at least this long
     *  (client-rendered shells are small; SSR pages are not) */
    minBytes?: number;
    /** browser render timeout (default 30s) */
    timeoutMs?: number;
    /** extra validation of the plain response (e.g. zeurelscan's fake 400s) */
    accept?: (response: Response, body: string) => boolean;
    /** error used when neither plain fetch nor the browser produced HTML */
    renderError?: string;
}

/** Fetch page text over plain HTTP, escalating to the anti-bot browser when
 *  the response is an error, too small, or a challenge shell. */
export async function fetchNativeText(url: string, options: NativeTextOptions): Promise<string> {
    let response: Response | undefined;
    try {
        response = await fetch(url, {
            headers: {
                'user-agent': randomUserAgent(),
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en,*;q=0.5',
                ...options.headers
            },
            redirect: 'follow',
            ...options.init
        });
    } catch {
        /* network error -> browser fallback below */
    }
    const body = response ? await response.text().catch(() => '') : '';
    const accepted =
        !!response &&
        (options.accept ? options.accept(response, body) : response.ok) &&
        !isAntiBotShell(body, response.status) &&
        body.length >= (options.minBytes ?? 0);
    if (accepted) {
        return body;
    }
    if (browserEnabled()) {
        const rendered = await getPageHTML(url, { timeoutMs: options.timeoutMs ?? 30_000 }).catch(() => undefined);
        if (rendered?.html && !isAntiBotShell(rendered.html)) {
            return rendered.html;
        }
    }
    if (response && !response.ok) {
        throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, options.id);
    }
    throw new SourceError(options.renderError ?? `Page protégée par anti-bot (JavaScript requis) sur ${new URL(url).hostname}`, options.id);
}
