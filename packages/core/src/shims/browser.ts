/**
 * Optional real-browser backend for sources protected by JavaScript anti-bot
 * (Cloudflare challenges, JS redirects, "Loading..." shells) that plain HTTP can
 * never render. Uses puppeteer-core against a system Chromium (no bundled
 * download) so the base image stays lean; the browser is launched lazily on first
 * need and reused.
 *
 * Enabled whenever a Chromium binary is detected - the Docker image ships one.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Browser, Page } from 'puppeteer-core';

/** External Chrome/Chromium exposing CDP (e.g. a podman container publishing
 * port 9222) - takes precedence over a local binary when set. */
const BROWSER_URL = process.env.TANKO_BROWSER_URL?.trim() || undefined;

const CHROMIUM_CANDIDATES = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

export function detectChromium(): string | undefined {
    return BROWSER_URL ? 'remote' : CHROMIUM_CANDIDATES.find(path => existsSync(path));
}

export function browserEnabled(): boolean {
    return detectChromium() !== undefined;
}

export type BrowserBackend = 'remote' | 'stealth' | 'headless' | 'none';

/** Which backend the last launch settled on - 'none' before any launch or when
 *  no Chromium exists at all, so a failure message can say what ran. */
let activeBackend: BrowserBackend = 'none';

export function browserBackend(): BrowserBackend {
    return browserEnabled() ? activeBackend : 'none';
}

/** Heuristic shared with the request shim: true when the page is a JS/anti-bot shell.
 *  `status` (when the caller has it) is the strongest signal - a 403/503 body
 *  is never usable payload. Challenge pages localize their <title> ("Un
 *  instant…", "Vérification de sécurité"). */
const CHALLENGE_TITLE =
    /<title[^>]*>\s*(?:loading|just a moment|checking|attention|verify|one more step|ddos|cf-|un instant|v[eé]rification|veuillez patienter|un momento|momento de espera|einen moment|attendere)/i;
const CHALLENGE_MARKER = /cdn-cgi\/challenge-platform|cf-chl-|challenges\.cloudflare\.com/i;
/** Below this size a page carrying challenge scripts cannot be real content. */
const THIN_PAGE_BYTES = 20_000;

export function isAntiBotShell(html: string, status?: number): boolean {
    if (!html) {
        return true;
    }
    if (status === 403 || status === 503) {
        return html.length < THIN_PAGE_BYTES || CHALLENGE_MARKER.test(html) || CHALLENGE_TITLE.test(html);
    }
    if (CHALLENGE_TITLE.test(html)) {
        return true;
    }
    // challenge scripts persist AFTER a successful solve -> they only count
    // when the page is too thin to be real content
    return (CHALLENGE_MARKER.test(html) && html.length < THIN_PAGE_BYTES) || html.length < 1000;
}

/** Strong challenge signals only: a WAF interstitial served with HTTP 200 is
 *  recognizable by its title or its challenge scripts, never by size alone
 *  (small legit AJAX fragments must not match). */
export function isChallengeShell(html: string): boolean {
    if (!html) {
        return false;
    }
    return CHALLENGE_TITLE.test(html) || (CHALLENGE_MARKER.test(html) && html.length < THIN_PAGE_BYTES);
}

interface PageResult {
    html: string;
    finalUrl: string;
}

let browserPromise: Promise<Browser> | undefined;
/** Shutdown in progress: getBrowser() waits for it, so a request never lands
 *  on a browser being closed (the idle shutdown lives in browser-session.ts). */
let closing: Promise<void> | undefined;
let activeUses = 0;

/** Hold the browser for one request. A use that leaves nobody holding it hands
 *  over to the idle shutdown, which decides against parked sessions. */
export function retainBrowser(): () => void {
    activeUses++;
    return () => {
        if (--activeUses === 0) {
            void import('./browser-session.js').then(module => module.reapIfIdle());
        }
    };
}

export function browserInUse(): boolean {
    return activeUses > 0;
}

/** The proxy as Chrome can use it (resolved by @tanko/server): a URL for
 *  --proxy-server, plus credentials for HTTP(S) proxies. */
export interface BrowserProxy {
    url: string;
    username?: string;
    password?: string;
}

let browserProxy: BrowserProxy | undefined;
let pageCredentials: { username: string; password: string } | undefined;

function proxyKey(proxy: BrowserProxy | undefined): string {
    return proxy ? `${proxy.username ?? ''}:${proxy.password ?? ''}@${proxy.url}` : '';
}

/** Route the browser through the same proxy as fetch(): a Cloudflare clearance
 *  is bound to the IP that solved the challenge, so a browser exiting elsewhere
 *  would solve for nothing. A change closes the browser and its sessions. */
export async function setBrowserProxy(proxy: BrowserProxy | undefined): Promise<void> {
    if (proxyKey(proxy) === proxyKey(browserProxy)) {
        return;
    }
    browserProxy = proxy;
    await closeBrowser();
}

/** puppeteer-real-browser loses the Chrome it launched whenever its CDP
 *  connection fails, and that tree weighs ~500 MB. Nothing else in the image
 *  runs a chrome-launcher profile: a leftover one is ours to kill. */
function killOrphanedLaunch(): Promise<void> {
    if (process.platform !== 'linux') {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        execFile('pkill', ['-f', 'user-data-dir=/tmp/lighthouse.'], () => resolve());
    });
}

function proxyLaunchOptions(): { flag?: string; credentials?: { username: string; password: string } } {
    const proxy = browserProxy;
    if (!proxy) {
        return {};
    }
    const credentials =
        proxy.username !== undefined || proxy.password !== undefined ? { username: proxy.username ?? '', password: proxy.password ?? '' } : undefined;
    return { flag: `--proxy-server=${proxy.url}`, credentials };
}

/** A new page carrying the proxy credentials when the backend does not set
 *  them itself (puppeteer-real-browser authenticates its own pages). */
export async function openPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    if (pageCredentials) {
        await page.authenticate(pageCredentials).catch(() => undefined);
    }
    return page;
}

function containPageSetupRejections(page: unknown): void {
    const proto = Object.getPrototypeOf(page) as {
        evaluateOnNewDocument(...args: unknown[]): Promise<unknown>;
        setupContained?: boolean;
    };
    if (proto.setupContained) {
        return;
    }
    proto.setupContained = true;
    const evaluateOnNewDocument = proto.evaluateOnNewDocument;
    proto.evaluateOnNewDocument = function (this: unknown, ...args: unknown[]): Promise<unknown> {
        return evaluateOnNewDocument.call(this, ...args).catch(() => undefined);
    };
}

async function launch(): Promise<Browser> {
    pageCredentials = undefined;
    if (BROWSER_URL) {
        // external browser (podman/docker container with CDP): connect, never own it
        if (browserProxy) {
            console.warn('[browser] outbound proxy ignored: the remote browser (TANKO_BROWSER_URL) manages its own network');
        }
        const { default: puppeteer } = await import('puppeteer-core');
        const browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
        activeBackend = 'remote';
        return browser;
    }
    const { flag, credentials } = proxyLaunchOptions();
    const executablePath = detectChromium();
    if (!executablePath) {
        throw new Error('No Chromium binary found');
    }
    await killOrphanedLaunch();
    const args = [
        ...(flag ? [flag] : []),
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled'
    ];
    // Preferred backend: puppeteer-real-browser (patchright-like stealth) which
    // auto-solves Cloudflare Turnstile challenges; it spawns its own Xvfb on
    // Linux when available (apt install xvfb / see Dockerfile). Optional
    // dependency -> fall back to plain puppeteer-core headless when absent.
    try {
        const { connect } = await import('puppeteer-real-browser');
        const { browser, page } = await connect({
            // 'auto' = headful under Xvfb when available (needed by the
            // Turnstile solver); typings only allow boolean
            headless: 'auto',
            customConfig: { chromePath: executablePath, chromeFlags: args },
            ...(credentials ? { proxy: credentials } : {}), // authenticates every page it opens
            turnstile: true
        } as unknown as Parameters<typeof connect>[0]);
        containPageSetupRejections(page);
        activeBackend = 'stealth';
        return browser as unknown as Browser;
    } catch (error) {
        // not installed (npm i --omit=optional) or launch failed: its Chrome is
        // orphaned (the connection that would own it never happened)
        await killOrphanedLaunch();
        console.warn('[browser] puppeteer-real-browser unavailable, falling back to plain headless (Turnstile auto-solve lost):', (error as Error).message);
    }
    // dynamic import so the dependency is only loaded when actually used
    const { default: puppeteer } = await import('puppeteer-core');
    pageCredentials = credentials;
    const browser = await puppeteer.launch({ executablePath, headless: true, args });
    activeBackend = 'headless';
    return browser;
}

export async function getBrowser(): Promise<Browser> {
    while (closing) {
        await closing;
    }
    // relaunch when the previous browser process died (connected === false)
    const cached = browserPromise ? await browserPromise.catch(() => undefined) : undefined;
    if (cached?.connected) {
        return cached;
    }
    browserPromise = launch().catch(error => {
        browserPromise = undefined; // allow retry on next call
        throw error;
    });
    return browserPromise;
}

/** One page on the shared browser for the duration of fn: the browser is
 *  held until the page is closed, so the idle shutdown never pulls it away. */
export async function withBrowserPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const release = retainBrowser();
    let page: Page | undefined;
    try {
        page = await openPage(await getBrowser());
        return await fn(page);
    } finally {
        await page?.close().catch(() => undefined);
        release();
    }
}

/**
 * Render a page in the real Chromium and return the resulting HTML plus the
 * final URL. The challenge (if any) is solved like a session's: the Turnstile
 * widget is clicked and the page polled until it is no longer a shell - with
 * the browser's own User-Agent, which the anti-bot cross-checks. Callers keep
 * their HTTP html when this throws (a resistant challenge).
 */
export async function getPageHTML(url: string, timeoutMs = 30000): Promise<PageResult> {
    const { openSolvedPage } = await import('./browser-session.js');
    const release = retainBrowser();
    try {
        const page = await openSolvedPage(new URL(url).origin, url, timeoutMs);
        try {
            // give client-side rendering a moment to finish
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => undefined);
            return { html: await page.content(), finalUrl: page.url() };
        } finally {
            await page.close().catch(() => undefined);
        }
    } finally {
        release();
    }
}

/** A browser that does not close must not wedge every later launch. */
export const EXIT_TIMEOUT_MS = 10_000;

/** Concurrent callers share one shutdown; the next getBrowser() relaunches. */
export function closeBrowser(): Promise<void> {
    if (!closing) {
        closing = shutdown().finally(() => {
            closing = undefined;
        });
    }
    return closing;
}

async function shutdown(): Promise<void> {
    // solved-session pages hold cookies for their origin: drop them first
    const { disposeSessions } = await import('./browser-session.js');
    await disposeSessions();
    const browser = browserPromise ? await browserPromise.catch(() => undefined) : undefined;
    browserPromise = undefined;
    if (!browser) {
        return;
    }
    // a remote browser is shared: releasing the connection keeps it running
    const closed = (BROWSER_URL ? browser.disconnect() : browser.close()).catch(() => undefined);
    await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, EXIT_TIMEOUT_MS).unref?.())]);
}
