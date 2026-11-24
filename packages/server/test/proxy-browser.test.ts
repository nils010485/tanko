/**
 * The anti-bot browser follows the outbound proxy: applyProxy() hands it the
 * proxy as Chrome can use it (the proxy itself for HTTP(S), the loopback
 * CONNECT relay for SOCKS5 and gost h2), and clears it. @tanko/core's browser
 * hook is a mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanko/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tanko/core')>()),
    setBrowserProxy: vi.fn(async () => undefined)
}));

import { setBrowserProxy } from '@tanko/core';
import { activeProxy, applyProxy } from '../src/util/proxy.js';

const set = (url: string) => applyProxy({ enabled: true, url });

beforeEach(() => {
    vi.mocked(setBrowserProxy).mockClear();
});

afterEach(async () => {
    await applyProxy({ enabled: false, url: '' });
});

describe('applyProxy', () => {
    it('gives Chrome the HTTP proxy itself, credentials included', async () => {
        await set('http://bot:s3cret@proxy.example:8080');
        expect(setBrowserProxy).toHaveBeenLastCalledWith({ url: 'http://proxy.example:8080', username: 'bot', password: 's3cret' });

        await set('https://proxy.example');
        expect(setBrowserProxy).toHaveBeenLastCalledWith({ url: 'https://proxy.example:443' });
    });

    it('points Chrome at the loopback relay for the tunnels it cannot carry (SOCKS5, gost h2)', async () => {
        await set('socks5://bot:s3cret@proxy.example:1080');
        expect(setBrowserProxy).toHaveBeenLastCalledWith({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });

        await set('http2://bot:s3cret@proxy.example');
        expect(setBrowserProxy).toHaveBeenLastCalledWith({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
    });

    it('clears it when the proxy is disabled, and leaves it alone for an unchanged URL', async () => {
        await set('http://proxy.example:8080');
        await set('http://proxy.example:8080');
        expect(setBrowserProxy).toHaveBeenCalledTimes(1);

        await applyProxy({ enabled: false, url: '' });
        expect(setBrowserProxy).toHaveBeenLastCalledWith(undefined);
        expect(activeProxy()).toBeNull();
    });
});
