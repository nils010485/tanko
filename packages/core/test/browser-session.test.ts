/**
 * Solved-session transport: challenge solving, navigation races, the 403
 * clearance rule and the per-origin backoff. Chromium is scripted (no browser
 * exists in CI): the real shell heuristic stays, the page is a fake.
 */
import type { Page } from 'puppeteer-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/shims/browser.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/shims/browser.js')>()),
    browserEnabled: vi.fn(() => true),
    browserBackend: vi.fn(() => 'stealth'),
    getBrowser: vi.fn()
}));

import { browserBackend, getBrowser, isChallengeShell } from '../src/shims/browser.js';
import { browserFetch, disposeSessions } from '../src/shims/browser-session.js';

const SHELL = '<html><head><title>Just a moment...</title></head><body>wait</body></html>';
const REAL = `<html><head><title>Aqua</title></head><body>${'content '.repeat(500)}</body></html>`;
/** Fat 403 body: passes the size heuristic, still a challenge (unrecognized title). */
const FAT_403 = `<html><head><title>Aqua</title></head><body>${'x'.repeat(30_000)}</body></html>`;
const AJAX_FRAGMENT = '{"success":true,"data":[]}';

type Handler = (payload: unknown) => void;

interface PageScript {
    /** successive content() results: an Error rejects, the last one repeats */
    contents?: Array<string | Error>;
    frames?: unknown[];
    cookies?: Array<{ name: string }>;
    /** main-frame navigation status fired from goto(), through the 'response' listener */
    navigationStatus?: number;
    response?: unknown;
}

function makePage(script: PageScript = {}) {
    const handlers = new Map<string, Set<Handler>>();
    const mainFrame = { url: () => 'https://aqua.test' };
    const contents = script.contents ?? [REAL];
    let reads = 0;
    const close = vi.fn(async () => undefined);
    const click = vi.fn(async () => undefined);
    const page = {
        on: (event: string, handler: Handler) => {
            const set = handlers.get(event) ?? new Set<Handler>();
            set.add(handler);
            handlers.set(event, set);
        },
        off: (event: string, handler: Handler) => {
            handlers.get(event)?.delete(handler);
        },
        isClosed: () => false,
        mainFrame: () => mainFrame,
        browser: () => ({ connected: true }),
        goto: async () => {
            for (const handler of handlers.get('response') ?? []) {
                handler(
                    script.response ?? {
                        status: () => script.navigationStatus ?? 200,
                        request: () => ({ isNavigationRequest: () => true }),
                        frame: () => mainFrame
                    }
                );
            }
            return null;
        },
        content: async () => {
            const next = contents[Math.min(reads++, contents.length - 1)];
            if (next instanceof Error) {
                throw next;
            }
            return next;
        },
        cookies: async () => script.cookies ?? [],
        frames: () => script.frames ?? [],
        evaluate: async () => ({ status: 200, ok: true, headers: {}, body: 'page' }),
        mouse: { click },
        waitForNetworkIdle: async () => undefined,
        close
    };
    return { page: page as unknown as Page, close, click };
}

function fakeBrowser(pages: Array<ReturnType<typeof makePage>['page']>) {
    const newPage = vi.fn(async () => {
        const next = pages.shift();
        if (!next) {
            throw new Error('no more scripted pages');
        }
        return next;
    });
    return { browser: { connected: true, newPage }, newPage };
}

/** Drive fake timers until the promise settles (polls, retry pauses, backoff). */
async function settle<T>(promise: Promise<T>, budgetMs = 200_000): Promise<T> {
    let settled = false;
    let error: unknown;
    let result: T | undefined;
    promise.then(
        value => {
            settled = true;
            result = value;
        },
        reason => {
            settled = true;
            error = reason;
        }
    );
    for (let waited = 0; waited < budgetMs && !settled; waited += 1000) {
        await vi.advanceTimersByTimeAsync(1000);
    }
    if (!settled) {
        throw new Error(`operation did not settle within ${budgetMs}ms of fake time`);
    }
    if (error) {
        throw error;
    }
    return result as T;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter neutral, retry pause 3500ms
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browserBackend).mockReturnValue('stealth');
});

afterEach(async () => {
    await disposeSessions();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(getBrowser).mockReset();
});

describe('solveOnce', () => {
    it('clicks the Turnstile widget inside its cross-origin iframe', async () => {
        const box = { x: 100, y: 200, width: 300, height: 65 };
        const widgetFrame = {
            url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile',
            frameElement: async () => ({ boundingBox: async () => box })
        };
        const page = makePage({ contents: [SHELL, SHELL, REAL], frames: [widgetFrame, { url: () => 'https://click.test' }] });
        vi.mocked(getBrowser).mockResolvedValue(fakeBrowser([page.page]).browser as never);

        const response = await settle(browserFetch('https://click.test', 'https://click.test/wp-admin/admin-ajax.php'));
        expect(response.body).toBe('page');
        // left-center of the iframe box, the same heuristic prb applies in-frame
        expect(page.click).toHaveBeenCalledWith(130, 232.5);
        expect(page.close).not.toHaveBeenCalled();
    });

    it('keeps polling when the post-solve navigation destroys the execution context', async () => {
        const page = makePage({ contents: [new Error('Execution context was destroyed.'), REAL] });
        vi.mocked(getBrowser).mockResolvedValue(fakeBrowser([page.page]).browser as never);

        const response = await settle(browserFetch('https://race.test', 'https://race.test/x'));
        expect(response.body).toBe('page');
        expect(page.close).not.toHaveBeenCalled(); // a navigation race is not a failure
    });

    it('refuses a fat 403 body without a cf_clearance cookie and times out honestly', async () => {
        const page = makePage({ contents: [FAT_403], navigationStatus: 403, cookies: [] });
        vi.mocked(getBrowser).mockResolvedValue(fakeBrowser([page.page, page.page]).browser as never);

        await expect(settle(browserFetch('https://fat.test', 'https://fat.test/x'))).rejects.toThrow(
            'anti-bot: challenge not solved within 30000ms on https://fat.test'
        );
        expect(page.close).toHaveBeenCalled();
    });

    it('accepts the same fat 403 body once the clearance cookie exists', async () => {
        const page = makePage({ contents: [FAT_403], navigationStatus: 403, cookies: [{ name: 'cf_clearance' }] });
        vi.mocked(getBrowser).mockResolvedValue(fakeBrowser([page.page]).browser as never);

        const response = await settle(browserFetch('https://cleared.test', 'https://cleared.test/x'));
        expect(response.body).toBe('page');
        expect(page.close).not.toHaveBeenCalled();
    });
});

describe('per-origin backoff', () => {
    it('doubles the delay per failed cycle, caps it, and resets after a success', async () => {
        const origin = 'https://backoff.test';
        vi.mocked(getBrowser).mockRejectedValue(new Error('No Chromium binary found'));

        const first = browserFetch(origin, `${origin}/x`);
        await expect(settle(first)).rejects.toThrow('No Chromium binary found');
        expect(console.warn).toHaveBeenCalledWith(`[anti-bot] solve failed on ${origin} (backend: stealth): No Chromium binary found - retry in 60s`);

        // the cooldown message carries the root cause, the backend and the wait
        await expect(browserFetch(origin, `${origin}/x`)).rejects.toThrow(
            `anti-bot: challenge solve failed recently on ${origin} (backend: stealth; last error: No Chromium binary found); retry in 60s`
        );

        for (const [wait, expected] of [
            [60_000, '120s'],
            [120_000, '240s'],
            [240_000, '480s'],
            [480_000, '900s'],
            [900_000, '900s']
        ] as Array<[number, string]>) {
            await vi.advanceTimersByTimeAsync(wait);
            await expect(settle(browserFetch(origin, `${origin}/x`))).rejects.toThrow('No Chromium binary found');
            await expect(browserFetch(origin, `${origin}/x`)).rejects.toThrow(`retry in ${expected}`);
        }

        // a healthy solve drops the origin's failure state
        await vi.advanceTimersByTimeAsync(900_000);
        vi.mocked(getBrowser).mockResolvedValue(fakeBrowser([makePage().page]).browser as never);
        const recovered = await settle(browserFetch(origin, `${origin}/x`));
        expect(recovered.body).toBe('page');

        // session expired again + a fresh failure -> back to the first rung
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
        vi.mocked(getBrowser).mockRejectedValue(new Error('No Chromium binary found'));
        await expect(settle(browserFetch(origin, `${origin}/x`))).rejects.toThrow('No Chromium binary found');
        await expect(browserFetch(origin, `${origin}/x`)).rejects.toThrow('retry in 60s');
    });
});

describe('withSession', () => {
    it.each(['Page crashed!', 'Execution context was destroyed.'])('evicts and retries once on "%s"', async message => {
        const origin = message.startsWith('Page') ? 'https://crash.test' : 'https://context.test';
        const dead = makePage();
        dead.page.evaluate = (async () => {
            throw new Error(message);
        }) as never;
        const fresh = makePage();
        const { browser, newPage } = fakeBrowser([dead.page, fresh.page]);
        vi.mocked(getBrowser).mockResolvedValue(browser as never);

        const response = await settle(browserFetch(origin, `${origin}/x`));
        expect(response.body).toBe('page');
        expect(newPage).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(dead.close).toHaveBeenCalled(); // dead tab closed without grace
    });
});

describe('isChallengeShell', () => {
    it('flags strong challenge signals only', () => {
        expect(isChallengeShell(SHELL)).toBe(true);
        expect(isChallengeShell('<html><head><title>Home</title><script src="/cdn-cgi/challenge-platform/x"></script></head><body>ok</body></html>')).toBe(
            true
        );
        expect(
            isChallengeShell(
                `<html><head><title>Home</title><script src="/cdn-cgi/challenge-platform/x"></script></head><body>${'y'.repeat(30_000)}</body></html>`
            )
        ).toBe(false);
        expect(isChallengeShell(AJAX_FRAGMENT)).toBe(false); // small legit fragment
        expect(isChallengeShell('')).toBe(false);
    });
});
