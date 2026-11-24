/**
 * Browser lifetime: one page per render, and the idle shutdown that must never
 * pull the browser from under a request. CDP is scripted through the remote
 * backend (TANKO_BROWSER_URL), the cheapest to fake.
 */
import puppeteer from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    process.env.TANKO_BROWSER_URL = 'http://127.0.0.1:9222';
});
vi.mock('puppeteer-core', () => ({ default: { connect: vi.fn(), launch: vi.fn() } }));

import { closeBrowser, EXIT_TIMEOUT_MS, getBrowser, getPageHTML } from '../src/shims/browser.js';
import { IDLE_SHUTDOWN_MS } from '../src/shims/browser-session.js';

const SHELL = '<html><head><title>Just a moment...</title></head><body>wait</body></html>';
const REAL = '<html><head><title>Home</title></head><body>content</body></html>';

function fakeBrowser(contents: string[] = [REAL]) {
    let reads = 0;
    const page = {
        url: () => 'https://x.test/',
        content: vi.fn(async () => contents[Math.min(reads++, contents.length - 1)]),
        close: vi.fn(async () => undefined),
        setUserAgent: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
        waitForNetworkIdle: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
        mainFrame: () => ({}),
        frames: () => [],
        isClosed: () => false,
        cookies: vi.fn(async () => []),
        mouse: { click: vi.fn(async () => undefined) }
    };
    const browser = {
        connected: true,
        newPage: vi.fn(async () => page),
        disconnect: vi.fn(async () => {
            browser.connected = false;
        })
    };
    return { browser, page };
}

const connect = vi.mocked(puppeteer.connect);

beforeAll(() => {
    vi.useFakeTimers();
});

afterAll(() => {
    delete process.env.TANKO_BROWSER_URL;
});

beforeEach(() => {
    connect.mockReset();
});

afterEach(async () => {
    await closeBrowser().catch(() => undefined);
    vi.useRealTimers();
    vi.useFakeTimers();
});

describe('getBrowser', () => {
    it('waits for a shutdown in progress, then relaunches', async () => {
        const first = fakeBrowser();
        const second = fakeBrowser();
        let finishClose!: () => void;
        first.browser.disconnect = vi.fn(() => new Promise<void>(resolve => (finishClose = resolve)));
        connect.mockResolvedValueOnce(first.browser as never).mockResolvedValueOnce(second.browser as never);
        expect(await getBrowser()).toBe(first.browser);

        const closing = closeBrowser();
        const next = getBrowser();
        try {
            let relaunched = false;
            next.then(() => (relaunched = true));
            for (let i = 0; i < 20; i++) {
                await Promise.resolve(); // microtasks only: the close is still pending
            }
            expect(relaunched).toBe(false);
        } finally {
            finishClose();
        }
        await closing;
        expect(await next).toBe(second.browser);
        expect(connect).toHaveBeenCalledTimes(2);
        expect(first.browser.disconnect).toHaveBeenCalledTimes(1);
    });

    it('shares one shutdown between concurrent callers', async () => {
        const { browser } = fakeBrowser();
        connect.mockResolvedValue(browser as never);
        await getBrowser();

        await Promise.all([closeBrowser(), closeBrowser()]);
        expect(browser.disconnect).toHaveBeenCalledTimes(1);
    });

    it('gives up on a browser that never closes, so the next launch is not wedged', async () => {
        const first = fakeBrowser();
        const second = fakeBrowser();
        first.browser.disconnect = vi.fn(() => new Promise<void>(() => undefined));
        connect.mockResolvedValueOnce(first.browser as never).mockResolvedValueOnce(second.browser as never);
        await getBrowser();

        const closing = closeBrowser();
        await vi.advanceTimersByTimeAsync(EXIT_TIMEOUT_MS);
        await closing;
        expect(await getBrowser()).toBe(second.browser);
    });
});

describe('one-off renders', () => {
    it('closes its page and releases the browser once the grace delay has passed', async () => {
        const { browser, page } = fakeBrowser();
        connect.mockResolvedValue(browser as never);

        expect(await getPageHTML('https://x.test/')).toEqual({ html: REAL, finalUrl: 'https://x.test/' });
        expect(page.close).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - 1);
        expect(browser.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(browser.disconnect).toHaveBeenCalledTimes(1);
    });

    it('solves the challenge like a session does, under the browser\u2019s own User-Agent', async () => {
        const { browser, page } = fakeBrowser([SHELL, SHELL, REAL]);
        connect.mockResolvedValue(browser as never);

        const rendering = getPageHTML('https://x.test/');
        await vi.advanceTimersByTimeAsync(3000);
        expect(await rendering).toEqual({ html: REAL, finalUrl: 'https://x.test/' });
        expect(page.content).toHaveBeenCalledTimes(4); // three polls, then the returned html
        expect(page.setUserAgent).not.toHaveBeenCalled();
        expect(page.goto).toHaveBeenCalledWith('https://x.test/', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
    });

    it('gives up on a resistant challenge: the page is closed, callers keep their HTTP html', async () => {
        const { browser, page } = fakeBrowser([SHELL]);
        connect.mockResolvedValue(browser as never);

        const rendering = getPageHTML('https://x.test/', 2000);
        const failure = expect(rendering).rejects.toThrow('anti-bot: challenge not solved within 2000ms on https://x.test');
        await vi.advanceTimersByTimeAsync(3000);
        await failure;
        expect(page.close).toHaveBeenCalledTimes(1);
    });

    it('keeps the browser across back-to-back renders: each one restarts the delay', async () => {
        const { browser } = fakeBrowser();
        connect.mockResolvedValue(browser as never);

        await getPageHTML('https://x.test/a');
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - 60_000);
        await getPageHTML('https://x.test/b');
        await vi.advanceTimersByTimeAsync(IDLE_SHUTDOWN_MS - 60_000);
        expect(browser.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(browser.disconnect).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(browser.newPage).toHaveBeenCalledTimes(2);
    });
});
