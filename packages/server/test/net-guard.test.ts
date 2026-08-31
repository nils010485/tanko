import { afterEach, describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, fetchGuarded, isPrivateAddress, readBodyCapped } from '../src/util/net-guard.js';

describe('isPrivateAddress', () => {
    it('blocks private/loopback/link-local/reserved IPv4', () => {
        for (const address of [
            '10.0.0.1',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.1',
            '127.0.0.1',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '192.0.0.1',
            '198.18.0.1',
            '198.19.255.1',
            '240.0.0.1',
            '255.255.255.255'
        ]) {
            expect(isPrivateAddress(address)).toBe(true);
        }
    });

    it('allows public IPv4 (incl. range neighbours)', () => {
        for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '11.0.0.1']) {
            expect(isPrivateAddress(address)).toBe(false);
        }
    });

    it('blocks loopback/ULA/link-local IPv6 and IPv4-mapped private', () => {
        for (const address of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '2002:0a00:1::1', '64:ff9b::808:808']) {
            expect(isPrivateAddress(address)).toBe(true);
        }
    });

    it('allows public IPv6 and IPv4-mapped public', () => {
        for (const address of ['2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
            expect(isPrivateAddress(address)).toBe(false);
        }
    });
});

describe('assertPublicHttpUrl', () => {
    it('rejects non-http(s) schemes', async () => {
        await expect(assertPublicHttpUrl('ftp://example.com/')).rejects.toThrow('http(s)');
        await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow('http(s)');
    });

    it('rejects private IP literals (v4, v6 bracketed)', async () => {
        await expect(assertPublicHttpUrl('http://192.168.1.1/x')).rejects.toThrow('Blocked private');
        await expect(assertPublicHttpUrl('http://127.0.0.1:8080/')).rejects.toThrow('Blocked private');
        await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow('Blocked private');
        await expect(assertPublicHttpUrl('http://[::ffff:10.0.0.5]/')).rejects.toThrow('Blocked private');
    });

    it('allows public IP literals without any DNS lookup', async () => {
        const target = await assertPublicHttpUrl('http://93.184.216.34/page');
        expect(target.hostname).toBe('93.184.216.34');
    });

    it('resolves hostnames and rejects private ones (localhost)', async () => {
        await expect(assertPublicHttpUrl('http://localhost/api')).rejects.toThrow('Blocked private');
    });
});

describe('fetchGuarded', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('follows redirects but blocks a hop to a private address', async () => {
        globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } })) as typeof fetch;
        await expect(fetchGuarded('http://93.184.216.34/start')).rejects.toThrow('Blocked private');
    });

    it('returns the final response on public hops', async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return calls === 1 ? new Response(null, { status: 301, headers: { location: 'http://93.184.216.34/final' } }) : new Response('ok');
        }) as typeof fetch;
        const response = await fetchGuarded('http://93.184.216.34/start');
        expect(response.status).toBe(200);
        expect(calls).toBe(2);
    });

    it('gives up after too many redirects', async () => {
        globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/loop' } })) as typeof fetch;
        await expect(fetchGuarded('http://93.184.216.34/loop')).rejects.toThrow('Too many redirects');
    });
});

describe('readBodyCapped', () => {
    it('rejects early when content-length exceeds the cap', async () => {
        const fake = { headers: new Headers({ 'content-length': '100' }), body: null } as unknown as Response;
        await expect(readBodyCapped(fake, 10)).rejects.toThrow('too large');
    });

    it('rejects mid-stream once the cap is exceeded', async () => {
        const response = new Response('x'.repeat(20));
        await expect(readBodyCapped(response, 10)).rejects.toThrow('too large');
    });

    it('returns small bodies as a Buffer', async () => {
        const response = new Response('hello');
        const body = await readBodyCapped(response, 10);
        expect(body.toString()).toBe('hello');
    });
});
