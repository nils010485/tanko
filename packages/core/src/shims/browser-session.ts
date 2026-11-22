/**
 * Solved-session browser transport: one warm page per origin.
 *
 * After a single page.goto() solves a Cloudflare challenge, a fetch()
 * evaluated INSIDE that page carries the cf_clearance cookies and Chrome's
 * real TLS fingerprint - including POSTs (page.goto cannot POST). One solve
 * therefore amortizes over a whole session of cheap in-page requests.
 *
 * Lifecycle rules (the health of this module is all about not closing pages
 * that in-flight evaluates still use):
 *  - solves are deduped per origin (inflight) and serialized globally (CF
 *    dislikes parallel challenges);
 *  - a page is never closed synchronously on eviction - evicted pages get a
 *    grace period, then close; requests that raced with the eviction retry
 *    once on a fresh session;
 *  - failed solves are negatively cached per origin with an exponential
 *    backoff and their last error kept: a host we cannot solve must not cost
 *    a 30s stall on every request, and the cause must stay visible.
 */

import type { Page } from 'puppeteer-core';
import { browserBackend, browserEnabled, getBrowser, isAntiBotShell } from './browser.js';

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
/** First delay of the per-origin backoff after a failed solve (no retry storm). */
const NEGATIVE_CACHE_MS = 60 * 1000;
/** Cap of the per-origin backoff: a blocked host is retried at this pace. */
const MAX_NEGATIVE_CACHE_MS = 15 * 60_000;
/** Pause between the two solve attempts: a CF rate-limit page needs a moment. */
const SOLVE_RETRY_PAUSE_MS = 3000;

interface Session {
    page: Page;
    expiresAt: number;
}

interface SolveFailure {
    until: number;
    delayMs: number;
    lastError: string;
}

const sessions = new Map<string, Session>();
const inflight = new Map<string, Promise<Page>>();
const solveFailures = new Map<string, SolveFailure>();
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
    return /target closed|session closed|browser has disconnected|protocol error|page crashed|execution context was destroyed/i.test(
        String((error as Error)?.message || '')
    );
}

/** Narrower check for a content() read: losing the execution context only means
 *  the page is navigating (post-solve redirect), the tab itself is alive. */
function isTabGone(error: unknown): boolean {
    return /target closed|session closed|browser has disconnected/i.test(String((error as Error)?.message || ''));
}

/** Record a failed solve cycle: exponential backoff, jittered, capped, with the
 *  root cause kept for the cooldown message. */
function recordSolveFailure(origin: string, error: unknown): void {
    const previous = solveFailures.get(origin);
    const grown = previous ? Math.min(previous.delayMs * 2, MAX_NEGATIVE_CACHE_MS) : NEGATIVE_CACHE_MS;
    const delayMs = Math.min(Math.round(grown * (0.8 + Math.random() * 0.4)), MAX_NEGATIVE_CACHE_MS);
    const lastError = (error as Error)?.message || String(error);
    solveFailures.set(origin, { until: Date.now() + delayMs, delayMs, lastError });
    console.warn(`[anti-bot] solve failed on ${origin} (backend: ${browserBackend()}): ${lastError} - retry in ${Math.round(delayMs / 1000)}s`);
}

/** cf_clearance for `origin`: the only proof that a 403/503 interstitial ran. */
async function hasClearance(page: Page, origin: string): Promise<boolean> {
    const cookies = await page.cookies(origin).catch(() => []);
    return cookies.some(cookie => cookie.name === 'cf_clearance');
}

/** Click the Cloudflare widget inside its cross-origin iframe. Best-effort: a
 *  solve must never fail on this helper, and the frame can detach mid-click. */
async function clickTurnstile(page: Page): Promise<void> {
    try {
        for (const frame of page.frames()) {
            if (!frame.url().includes('challenges.cloudflare.com')) {
                continue;
            }
            try {
                const box = await (await frame.frameElement())?.boundingBox();
                if (!box || box.width === 0 || box.height === 0) {
                    continue; // widget not laid out yet (hidden or still mounting)
                }
                // left-center heuristic, on the IFRAME box: the checkbox sits at
                // the widget's left edge
                await page.mouse.click(box.x + 30, box.y + box.height / 2);
            } catch {
                /* frame detached between frames() and the click: next cycle */
            }
        }
    } catch {
        /* no frames / page gone: polling decides the outcome */
    }
}

/** Navigate to the origin and wait until the challenge (if any) is solved. */
async function solve(origin: string): Promise<Page> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await solveOnce(origin);
        } catch (error) {
            if (attempt >= 1) {
                recordSolveFailure(origin, error);
                throw error;
            }
            // let a rate-limit interstitial settle before the second attempt
            await new Promise(resolve => setTimeout(resolve, SOLVE_RETRY_PAUSE_MS + Math.random() * 1000));
        }
    }
}

async function solveOnce(origin: string): Promise<Page> {
    const browser = await getBrowser();
    const page = await browser.newPage();
    /** Status of the last main-frame navigation: a 403/503 needs a clearance
     *  cookie, however large the shell body is. */
    let status: number | undefined;
    const onResponse = (response: { status(): number; request(): { isNavigationRequest(): boolean }; frame(): unknown }): void => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
            status = response.status();
        }
    };
    page.on('response', onResponse);
    try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: SOLVE_TIMEOUT_MS });
        // poll instead of one fixed wait: Turnstile auto-solve takes ~7-9s
        const deadline = Date.now() + SOLVE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            let html: string | undefined;
            try {
                html = await page.content();
            } catch (error) {
                // the post-solve redirect destroys the execution context: the
                // page is alive and polling again is the right move
                if (page.isClosed() || isTabGone(error)) {
                    throw error;
                }
            }
            if (html !== undefined && !isAntiBotShell(html)) {
                if (status !== 403 && status !== 503) {
                    return page;
                }
                // a fat 403/503 body passes the size heuristic without ever
                // having been solved: only the clearance cookie proves it
                if (await hasClearance(page, origin)) {
                    return page;
                }
            }
            await clickTurnstile(page);
            await new Promise(resolve => setTimeout(resolve, SOLVE_POLL_MS));
        }
        throw new Error(`anti-bot: challenge not solved within ${SOLVE_TIMEOUT_MS}ms on ${origin}`);
    } catch (error) {
        await page.close().catch(() => undefined);
        throw error;
    } finally {
        page.off('response', onResponse);
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
    const failure = solveFailures.get(origin);
    if (failure && Date.now() < failure.until) {
        throw new Error(
            `anti-bot: challenge solve failed recently on ${origin} (backend: ${browserBackend()}; last error: ${failure.lastError}); retry in ${Math.ceil((failure.until - Date.now()) / 1000)}s`
        );
    }
    // dedupe concurrent solves for the same origin behind one promise
    let pending = inflight.get(origin);
    if (!pending) {
        pending = queuedSolve(origin).then(page => {
            sessions.set(origin, { page, expiresAt: Date.now() + BROWSER_SESSION_MS });
            solveFailures.delete(origin);
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
 * keys) hide the image list from the DOM - but the reader still has to fetch
 * the real images. Render `url` on the session page and collect every image
 * URL seen in a response body or a request, deduped and index-sorted.
 * Captures are serialized: they navigate the shared per-origin page.
 */
/** Default capture pattern (Madara themes): group 1 = page order index. */
const CAPTURE_IMAGE_PATTERN = /https?:\/\/[^\s"'\\]+?\/image_(\d+)\.(?:jpe?g|png|webp|avif)/gi;

export async function browserCapturePageImages(origin: string, url: string, timeoutMs = 30_000, imagePattern?: RegExp): Promise<string[]> {
    requireBrowser();
    const run = async (page: Page): Promise<string[]> => {
        const seen = new Map<number, string>();
        const pattern = imagePattern ?? CAPTURE_IMAGE_PATTERN;
        const collect = (text: string): void => {
            for (const match of text.matchAll(pattern)) {
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
            // lazy-load readers (e.g. manhwaread) only request images as they
            // scroll into view: walk the page once to flush them all out
            await page
                .evaluate(async () => {
                    for (let y = 0; y < document.body.scrollHeight; y += 700) {
                        window.scrollTo(0, y);
                        await new Promise(resolve => setTimeout(resolve, 220));
                    }
                })
                .catch(() => undefined);
            await page.waitForNetworkIdle({ idleTime: 1200, timeout: 10_000 }).catch(() => undefined);
        } finally {
            page.off('request', onRequest);
            page.off('response', onResponse);
        }
        return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, imageUrl]) => imageUrl);
    };
    // navigate the shared session page one capture at a time; an empty
    // capture smells like an expired clearance: evict and retry once
    const queued = captureQueue.catch(() => undefined).then(() => withSession(origin, run, images => images.length === 0));
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
