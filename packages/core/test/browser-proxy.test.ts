/**
 * Outbound proxy at browser launch: Chrome's switch, the per-page credentials,
 * the relaunch on a change, and the Chrome orphaned by a failed
 * puppeteer-real-browser connection. Scripted through the stealth backend,
 * where the flags are visible, then the plain-headless fallback.
 */
import { execFile } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    delete process.env.TANKO_BROWSER_URL;
});
vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: vi.fn(() => true) }));
vi.mock('node:child_process', async importOriginal => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFile: vi.fn((...args: unknown[]) => {
        (args[args.length - 1] as () => void)();
    })
}));
vi.mock('puppeteer-core', () => ({ default: { connect: vi.fn(), launch: vi.fn() } }));
const realBrowser = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('puppeteer-real-browser', () => ({ connect: realBrowser.connect }));

import { closeBrowser, getBrowser, openPage, setBrowserProxy } from '../src/shims/browser.js';

interface LaunchOptions {
    customConfig: { chromeFlags: string[] };
    proxy?: { username: string; password: string };
}

function makeBrowser() {
    const browser = {
        connected: true,
        newPage: vi.fn(),
        close: vi.fn(async () => {
            browser.connected = false;
        })
    };
    return browser;
}

function stealthBrowser() {
    const launched: Array<ReturnType<typeof makeBrowser>> = [];
    realBrowser.connect.mockImplementation(async () => {
        const browser = makeBrowser();
        launched.push(browser);
        return { browser, page: Object.create({ evaluateOnNewDocument: async () => undefined }) };
    });
    return launched;
}

const launchOptions = (call = 0): LaunchOptions => realBrowser.connect.mock.calls[call][0] as LaunchOptions;
const pkillCalls = () => vi.mocked(execFile).mock.calls.filter(call => call[0] === 'pkill');

beforeEach(() => {
    realBrowser.connect.mockReset();
    vi.mocked(puppeteer.launch).mockReset();
    vi.mocked(execFile).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
    await setBrowserProxy(undefined);
    await closeBrowser();
    vi.restoreAllMocks();
});

describe('setBrowserProxy', () => {
    it('gives Chrome the proxy switch and puppeteer-real-browser the credentials', async () => {
        stealthBrowser();
        await setBrowserProxy({ url: 'http://proxy.example:8080', username: 'bot', password: 's3cret' });
        await getBrowser();
        expect(launchOptions().customConfig.chromeFlags).toContain('--proxy-server=http://proxy.example:8080');
        expect(launchOptions().proxy).toEqual({ username: 'bot', password: 's3cret' });
    });

    it('passes the loopback relay through as is: no credentials on localhost', async () => {
        stealthBrowser();
        await setBrowserProxy({ url: 'http://127.0.0.1:43123' });
        await getBrowser();
        expect(launchOptions().customConfig.chromeFlags).toContain('--proxy-server=http://127.0.0.1:43123');
        expect(launchOptions().proxy).toBeUndefined();
    });

    it('closes the browser when the proxy changes, and the next launch uses the new one', async () => {
        const launched = stealthBrowser();
        await setBrowserProxy({ url: 'http://a.example:8080' });
        await getBrowser();

        await setBrowserProxy({ url: 'http://b.example:3128' });
        expect(launched[0].close).toHaveBeenCalledTimes(1);
        await getBrowser();
        expect(realBrowser.connect).toHaveBeenCalledTimes(2);
        expect(launchOptions(1).customConfig.chromeFlags).toContain('--proxy-server=http://b.example:3128');

        await setBrowserProxy(undefined);
        expect(launched[1].close).toHaveBeenCalledTimes(1);
        await getBrowser();
        expect(launchOptions(2).customConfig.chromeFlags.some(flag => flag.startsWith('--proxy-server'))).toBe(false);
    });

    it('the plain-headless fallback authenticates every page itself', async () => {
        realBrowser.connect.mockRejectedValue(new Error('no xvfb'));
        const page = { authenticate: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
        const browser = { connected: true, newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
        vi.mocked(puppeteer.launch).mockResolvedValue(browser as never);
        await setBrowserProxy({ url: 'http://proxy.example:8080', username: 'bot', password: 's3cret' });

        expect(await openPage(await getBrowser())).toBe(page);
        expect(page.authenticate).toHaveBeenCalledWith({ username: 'bot', password: 's3cret' });
    });
});

describe('orphaned stealth Chrome', () => {
    // puppeteer-real-browser launches Chrome before connecting to it: when the
    // connection fails, that Chrome (a chrome-launcher profile) has no owner
    it.skipIf(process.platform !== 'linux')('is killed before every launch and again after a failed connection', async () => {
        realBrowser.connect.mockRejectedValue(new Error('Failed to fetch browser webSocket URL from http://127.0.0.1:35517/json/version: fetch failed'));
        const browser = makeBrowser();
        vi.mocked(puppeteer.launch).mockResolvedValue(browser as never);

        expect(await getBrowser()).toBe(browser); // the plain-headless fallback took over
        expect(pkillCalls()).toEqual([
            ['pkill', ['-f', 'user-data-dir=/tmp/lighthouse.'], expect.any(Function)],
            ['pkill', ['-f', 'user-data-dir=/tmp/lighthouse.'], expect.any(Function)]
        ]);
    });
});
