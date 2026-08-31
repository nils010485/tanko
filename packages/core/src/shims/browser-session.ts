/**
 * Solved-session browser transport: one warm page per origin.
 *
 * After a single page.goto() solves a Cloudflare challenge, a fetch()
 * evaluated INSIDE that page carries the cf_clearance cookies and Chrome's
 * real TLS fingerprint — including POSTs (page.goto cannot POST). One solve
 * therefore amortizes over a whole session of cheap in-page requests.
 *
 * Lifecycle rules (the health of this module is all about not closing pages
 * that in-flight evaluates still use):
 *  - solves are deduped per origin (inflight) and serialized globally (CF
 *    dislikes parallel challenges);
 *  - a page is never closed synchronously on eviction — evicted pages get a
 *    grace period, then close; requests that raced with the eviction retry
 *    once on a fresh session;
 *  - failed solves are negatively cached per origin: a host we cannot solve
 *    must not cost a 30s stall on every request.
 */

import type { Page } from 'puppeteer-core';
import { browserEnabled, getBrowser, isAntiBotShell } from './browser.js';

export interface BrowserResponse {
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
}

/** How long a solved session is trusted before re-solving preventively. */
export const BROWSER_SESSION_MS = 30 * 60 * 1000;
const SOLVE_TIMEOUT_MS = 30_000;
const SOLVE_POLL_MS = 1000;
/** Evicted pages stay alive this long: in-flight evaluates may still run. */
const GRACE_CLOSE_MS = 60_000;
/** A failed solve poisons its origin for this long (no retry storm). */
const NEGATIVE_CACHE_MS = 5 * 60 * 1000;

interface Session {
    page: Page;
    expiresAt: number;
}

const sessions = new Map<string, Session>();
const inflight = new Map<string, Promise<Page>>();
const solveFailUntil = new Map<string, number>();
/** Global solve serialization, kept separate from the per-origin dedupe. */
let solveQueue: Promise<unknown> = Promise.resolve();
/** Captures navigate the shared session page: one at a time, all origins. */
let captureQueue: Promise<unknown> = Promise.resolve();

/** Shared guard: every exported transport needs the optional browser backend. */
function requireBrowser(): void {
    if (!browserEnabled()) {
        throw new Error('anti-bot: no browser backend (install chromium + xvfb, or use the Docker image)');
    }
}

/** Remove the origin's session; the page closes after a grace period so any
 *  request still evaluating on it can finish. */
function evict(origin: string, closeAfterMs = GRACE_CLOSE_MS): void {
    const session = sessions.get(origin);
    if (!session) {
        return;
    }
    sessions.delete(origin);
    const timer = setTimeout(() => session.page.close().catch(() => undefined), closeAfterMs);
    timer.unref?.();
}

/** A dead tab crashes evaluate with one of these protocol errors. */
function isPageDeath(error: unknown): boolean {
    return /target closed|session closed|browser has disconnected|protocol error/i.test(String((error as Error)?.message || ''));
}

/** Navigate to the origin and wait until the challenge (if any) is solved. */
async function solve(origin: string): Promise<Page> {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: SOLVE_TIMEOUT_MS });
        // poll instead of one fixed wait: Turnstile auto-solve takes ~7-9s
        const deadline = Date.now() + SOLVE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (!isAntiBotShell(await page.content())) {
                return page;
            }
            await new Promise(resolve => setTimeout(resolve, SOLVE_POLL_MS));
        }
        throw new Error(`anti-bot: challenge not solved within ${SOLVE_TIMEOUT_MS}ms on ${origin}`);
    } catch (error) {
        await page.close().catch(() => undefined);
        solveFailUntil.set(origin, Date.now() + NEGATIVE_CACHE_MS);
        throw error;
    }
}

function queuedSolve(origin: string): Promise<Page> {
    const run = solveQueue.catch(() => undefined).then(() => solve(origin));
    solveQueue = run.catch(() => undefined);
    return run;
}

async function getSession(origin: string): Promise<Page> {
    const cached = sessions.get(origin);
    if (cached && cached.expiresAt > Date.now() && cached.page.browser().connected && !cached.page.isClosed()) {
        return cached.page;
    }
    if (cached) {
        evict(origin);
    }
    if (Date.now() < (solveFailUntil.get(origin) ?? 0)) {
        throw new Error(`anti-bot: challenge solve failed recently on ${origin}; not retrying yet`);
    }
    // dedupe concurrent solves for the same origin behind one promise
    let pending = inflight.get(origin);
    if (!pending) {
        pending = queuedSolve(origin).then(page => {
            sessions.set(origin, { page, expiresAt: Date.now() + BROWSER_SESSION_MS });
            solveFailUntil.delete(origin);
            // idle expiry: a session nobody revisits must not hold a tab forever
            const timer = setTimeout(() => {
                const session = sessions.get(origin);
                if (session && session.expiresAt <= Date.now()) {
                    evict(origin, 0);
                }
            }, BROWSER_SESSION_MS + GRACE_CLOSE_MS);
            timer.unref?.();
            return page;
        });
        inflight.set(origin, pending);
        const cleanup = () => inflight.delete(origin);
        pending.then(cleanup, cleanup);
    }
    return pending;
}

/** Run fn on the solved session, with the shared eviction policy: an early
 *  challenge (clearance expired) or a dead tab evicts the session and retries
 *  exactly once on a fresh one. */
async function withSession<T>(origin: string, fn: (page: Page) => Promise<T>, isChallenge: (result: T) => boolean): Promise<T> {
    let page = await getSession(origin);
    let result: T;
    try {
        result = await fn(page);
    } catch (error) {
        if (!isPageDeath(error)) {
            throw error;
        }
        evict(origin, 0); // tab already dead: no grace needed
        page = await getSession(origin);
        result = await fn(page);
    }
    if (isChallenge(result)) {
        // clearance expired early -> fresh session, retry exactly once
        evict(origin);
        result = await fn(await getSession(origin));
    }
    return result;
}

/** Run fetch() inside the given page context (private helper). */
async function evaluateFetch(page: Page, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<BrowserResponse> {
    return page.evaluate(
        async (requestUrl, requestInit) => {
            const response = await fetch(requestUrl, requestInit);
            return {
                status: response.status,
                ok: response.ok,
                headers: Object.fromEntries(response.headers.entries()),
                body: await response.text()
            };
        },
        url,
        init
    );
}

/** fetch() evaluated inside a solved page for `origin`: real Chrome TLS +
 *  cf_clearance cookies, POST included. */
export async function browserFetch(
    origin: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<BrowserResponse> {
    requireBrowser();
    return withSession(
        origin,
        page => evaluateFetch(page, url, init),
        result => (result.status === 403 || result.status === 503) && isAntiBotShell(result.body, result.status)
    );
}

/** Binary variant for page images (base64 over the evaluate boundary). */
export async function browserFetchBinary(origin: string, url: string): Promise<{ status: number; mime: string; data: Uint8Array }> {
    requireBrowser();
    const result = await withSession(
        origin,
        page =>
            page.evaluate(async requestUrl => {
                const response = await fetch(requestUrl);
                const bytes = new Uint8Array(await response.arrayBuffer());
                let binary = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return { status: response.status, mime: response.headers.get('content-type') || 'image/', base64: btoa(binary) };
            }, url),
        // no text body to inspect on the binary path: status alone decides
        result => result.status === 403 || result.status === 503
    );
    return { status: result.status, mime: result.mime, data: new Uint8Array(Buffer.from(result.base64, 'base64')) };
}
/**
 * Readers that decode their pages client-side (blob: URLs, obfuscated ajax
 * keys) hide the image list from the DOM — but the reader still has to fetch
 * the real images. Render `url` on the session page and collect every image
 * URL seen in a response body or a request, deduped and index-sorted.
 * Captures are serialized: they navigate the shared per-origin page.
 */
export async function browserCapturePageImages(origin: string, url: string, timeoutMs = 30_000): Promise<string[]> {
    requireBrowser();
    const run = async (): Promise<string[]> => {
        const page = await getSession(origin);
        const seen = new Map<number, string>();
        const collect = (text: string): void => {
            for (const match of text.matchAll(/https?:\/\/[^\s"'\\]+?\/image_(\d+)\.(?:jpe?g|png|webp|avif)/gi)) {
                seen.set(Number(match[1]), match[0].replace(/\\/g, ''));
            }
        };
        const onRequest = (request: { url(): string }): void => collect(request.url());
        const onResponse = (response: { url(): string; text(): Promise<string> }): void => {
            // the full list arrives in an ajax JSON payload; DOM requests only
            // prove what already scrolled by
            if (response.url().includes('admin-ajax')) {
                void response
                    .text()
                    .then(collect)
                    .catch(() => undefined);
            }
        };
        page.on('request', onRequest);
        page.on('response', onResponse);
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
            await new Promise(resolve => setTimeout(resolve, 1000)); // late ajax settles
        } finally {
            page.off('request', onRequest);
            page.off('response', onResponse);
        }
        return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, imageUrl]) => imageUrl);
    };
    // navigate the shared session page one capture at a time
    const queued = captureQueue.catch(() => undefined).then(run);
    captureQueue = queued.catch(() => undefined);
    return queued;
}

/** Drop every solved session (called by closeBrowser on shutdown). */
export async function disposeSessions(): Promise<void> {
    const pages = [...sessions.values()].map(session => session.page);
    sessions.clear();
    inflight.clear();
    await Promise.all(pages.map(page => page.close().catch(() => undefined)));
}
