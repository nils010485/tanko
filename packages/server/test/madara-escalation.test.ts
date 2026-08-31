/**
 * MadaraConnector anti-bot escalation, with the browser shims mocked at the
 * dist level (the server package consumes @tanko/core through dist/).
 */
import { MadaraConnector, SourceError } from '@tanko/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real isAntiBotShell is covered in antibot.test.ts; the escalation only
// needs a deterministic predicate: challenge title or 403 status.
vi.mock('../../core/dist/shims/browser.js', () => ({
    detectChromium: vi.fn(),
    browserEnabled: vi.fn(() => true),
    isAntiBotShell: vi.fn((html: string, status?: number) => status === 403 || /un instant|just a moment|vérification/i.test(html)),
    getBrowser: vi.fn(),
    getPageHTML: vi.fn(),
    closeBrowser: vi.fn()
}));
vi.mock('../../core/dist/shims/browser-session.js', () => ({
    browserFetch: vi.fn(),
    browserFetchBinary: vi.fn(),
    BROWSER_SESSION_MS: 30 * 60 * 1000,
    disposeSessions: vi.fn()
}));

import { browserFetch } from '../../core/dist/shims/browser-session.js';

const fetchMock = vi.fn();
const challenge403 = () =>
    new Response('<html><head><title>Un instant…</title></head><body>challenge</body></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' }
    });

const okHtml = (title: string) => `<html><head><title>${title}</title></head><body>${'content '.repeat(500)}</body></html>`;

function connector(): MadaraConnector {
    return new MadaraConnector({ id: 'test', label: 'Test', base: 'https://madara.test' });
}

beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => challenge403());
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(browserFetch).mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('MadaraConnector anti-bot escalation', () => {
    it('escalates a proven challenge to the browser session and parses the result', async () => {
        vi.mocked(browserFetch).mockResolvedValue({
            status: 200,
            ok: true,
            headers: {},
            body: JSON.stringify({ success: true, data: [{ title: 'Solo Manga', url: 'https://madara.test/manga/solo/' }] })
        });
        const results = await connector().searchMangas('solo');
        expect(results).toHaveLength(1);
        expect(results[0]?.title).toBe('Solo Manga');
        expect(fetchMock).toHaveBeenCalledTimes(1); // one raw attempt, then escalation
        expect(browserFetch).toHaveBeenCalledWith('https://madara.test', 'https://madara.test/wp-admin/admin-ajax.php', expect.anything());
    });

    it('stays in browser mode: later requests skip the doomed raw attempt', async () => {
        vi.mocked(browserFetch).mockResolvedValue({
            status: 200,
            ok: true,
            headers: {},
            body: JSON.stringify({ success: true, data: [{ title: 'A', url: 'https://madara.test/manga/a/' }] })
        });
        const source = connector();
        await source.searchMangas('a');
        await source.searchMangas('b');
        expect(fetchMock).toHaveBeenCalledTimes(1); // second search went straight to the browser
        expect(browserFetch).toHaveBeenCalledTimes(2);
    });

    it('fails with a classifiable anti-bot error when no browser exists', async () => {
        const { browserEnabled } = await import('../../core/dist/shims/browser.js');
        vi.mocked(browserEnabled).mockReturnValue(false);
        try {
            await expect(connector().searchMangas('a')).rejects.toThrow(/^anti-bot: .*no Chromium available/u);
            await expect(connector().searchMangas('a')).rejects.toThrow(SourceError);
        } finally {
            vi.mocked(browserEnabled).mockReturnValue(true);
        }
    });

    it('checkHealth: raw probes challenged, browser solves -> ok via browser', async () => {
        vi.mocked(browserFetch).mockResolvedValue({ status: 200, ok: true, headers: {}, body: okHtml('Madara Test - Search') });
        const result = await connector().checkHealth();
        expect(result.ok).toBe(true);
        expect(result.via).toBe('browser');
        expect(result.error).toBeUndefined();
    });

    it('checkHealth: browser present but solve fails -> honest anti-bot error', async () => {
        vi.mocked(browserFetch).mockRejectedValue(new Error('anti-bot: challenge not solved within 30000ms on https://madara.test'));
        const result = await connector().checkHealth();
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/^anti-bot:/);
    });
});
