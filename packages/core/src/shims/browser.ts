/**
 * Optional real-browser backend for sources protected by JavaScript anti-bot
 * (Cloudflare challenges, JS redirects, "Loading..." shells) that plain HTTP can
 * never render. Uses puppeteer-core against a system Chromium (no bundled
 * download) so the base image stays lean; the browser is launched lazily on first
 * need and reused.
 *
 * Enabled by default when a Chromium binary is detected; force off with
 * HEADLESS_BROWSER=0, or point to a custom binary with CHROMIUM_PATH.
 */
import { existsSync } from 'node:fs';
import type { Browser } from 'puppeteer-core';

const CHROMIUM_CANDIDATES = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable'
].filter(Boolean) as string[];

export function detectChromium(): string | undefined {
    return CHROMIUM_CANDIDATES.find(path => existsSync(path));
}

export function browserEnabled(): boolean {
    if (process.env.HEADLESS_BROWSER === '0' || process.env.HEADLESS_BROWSER === 'false') {
        return false;
    }
    return detectChromium() !== undefined;
}

/** Heuristic shared with the request shim: true when the page is a JS/anti-bot shell. */
export function isAntiBotShell(html: string): boolean {
    if (!html) {
        return true;
    }
    return /<title[^>]*>\s*(loading|just a moment|checking|attention|verify|one more step|ddos|cf-)/i.test(html)
        || html.length < 1000;
}

interface PageResult {
    html: string;
    finalUrl: string;
}

let browserPromise: Promise<Browser> | undefined;

async function launch(): Promise<Browser> {
    const executablePath = detectChromium();
    if (!executablePath) {
        throw new Error('No Chromium binary found');
    }
    // dynamic import so the dependency is only loaded when actually used
    const { default: puppeteer } = await import('puppeteer-core');
    return puppeteer.launch({
        executablePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled'
        ]
    });
}

function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
        browserPromise = launch().catch(error => {
            browserPromise = undefined; // allow retry on next call
            throw error;
        });
    }
    return browserPromise;
}

/**
 * Render a page in a real headless Chromium and return the resulting HTML plus the
 * final URL (after any JS redirect / challenge). Waits for the network to settle so
 * client-side redirects complete.
 */
export async function getPageHTML(url: string, options: { userAgent?: string; referer?: string; timeoutMs?: number } = {}): Promise<PageResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const browser = await getBrowser();
    const page = await browser.newPage();
    // hide the automation fingerprint so Cloudflare/anti-bot see a normal browser
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
    }).catch(() => undefined);
    try {
        if (options.userAgent) {
            await page.setUserAgent(options.userAgent);
        }
        if (options.referer) {
            await page.setExtraHTTPHeaders({ Referer: options.referer });
        }
        await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
        // give client-side redirects / challenge solvers a moment to run
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }).catch(() => undefined);
        const html: string = await page.content();
        const finalUrl: string = page.url();
        return { html, finalUrl };
    } finally {
        await page.close().catch(() => undefined);
    }
}

export async function closeBrowser(): Promise<void> {
    if (browserPromise) {
        const browser = await browserPromise.catch(() => undefined);
        browserPromise = undefined;
        await browser?.close().catch(() => undefined);
    }
}
