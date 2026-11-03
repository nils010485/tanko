/**
 * Outbound proxy: URL parsing and the SOCKS5 tunnel (undici's ProxyAgent only
 * speaks HTTP tunnels, so SOCKS5 and HTTP/2 go through our loopback relay).
 */
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { applyProxy, installProxyFetch, parseProxyUrl } from '../src/util/proxy.js';

// the server patches fetch() once at boot; the tests need the same hook
installProxyFetch();

describe('parseProxyUrl', () => {
    it('reads the scheme, the explicit port and the credentials', () => {
        expect(parseProxyUrl('socks5h://bot:s3cret@proxy.example:443')).toEqual({
            protocol: 'socks5',
            host: 'proxy.example',
            port: 443,
            username: 'bot',
            password: 's3cret'
        });
    });

    it('accepts every supported scheme and defaults its port', () => {
        expect(parseProxyUrl('socks5://127.0.0.1')).toMatchObject({ protocol: 'socks5', port: 1080 });
        expect(parseProxyUrl('http://127.0.0.1')).toMatchObject({ protocol: 'http', port: 8080 });
        expect(parseProxyUrl('https://127.0.0.1')).toMatchObject({ protocol: 'https', port: 443 });
        expect(parseProxyUrl('http2://proxy.example')).toMatchObject({ protocol: 'http2', port: 443 });
        expect(parseProxyUrl('h2://proxy.example')).toMatchObject({ protocol: 'http2', port: 443 });
    });

    it('keeps an empty password and decodes the percent-encoded ones', () => {
        expect(parseProxyUrl('socks5://user:@host:1080')).toMatchObject({ username: 'user', password: '' });
        expect(parseProxyUrl('socks5://user:p%40ss@host:1080')).toMatchObject({ password: 'p@ss' });
    });

    it('rejects unsupported schemes, empty strings and non-URLs', () => {
        expect(() => parseProxyUrl('')).toThrow(/empty/);
        expect(() => parseProxyUrl('ftp://host:21')).toThrow(/Unsupported proxy scheme/);
        expect(() => parseProxyUrl('nonsense')).toThrow(/Invalid proxy URL/);
    });
});

/** Read exactly `size` bytes from a paused socket (handshake exchanges). */
function socketReader(socket: net.Socket) {
    let pending = Buffer.alloc(0);
    return async (size: number): Promise<Buffer> => {
        while (pending.length < size) {
            const chunk = socket.read() as Buffer | null;
            if (chunk) {
                pending = Buffer.concat([pending, chunk]);
            } else {
                await once(socket, 'readable');
            }
        }
        const out = pending.subarray(0, size);
        pending = pending.subarray(size);
        return out;
    };
}

/** Minimal SOCKS5 server dialing the requested target; optionally requires
 *  username/password (RFC 1929) so the client-side auth path gets covered. */
async function startSocks5Server(options: { username?: string; password?: string } = {}): Promise<{
    port: number;
    seen: string[];
    close: () => Promise<void>;
}> {
    const seen: string[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        void (async () => {
            const read = socketReader(socket);
            const [, count] = await read(2);
            const methods = await read(count);
            const needsAuth = options.username !== undefined;
            if (needsAuth && !methods.includes(0x02)) {
                socket.end(Buffer.from([0x05, 0xff]));
                return;
            }
            socket.write(Buffer.from([0x05, needsAuth ? 0x02 : 0x00]));
            if (needsAuth) {
                const [, userLength] = await read(2);
                const username = (await read(userLength)).toString('utf8');
                const [passwordLength] = await read(1);
                const password = (await read(passwordLength)).toString('utf8');
                const valid = username === options.username && password === options.password;
                socket.write(Buffer.from([0x01, valid ? 0x00 : 0x01]));
                if (!valid) {
                    socket.end();
                    return;
                }
            }
            const [, , , family] = await read(4);
            const hostLength = family === 0x03 ? (await read(1))[0] : 0;
            const host = (await read(hostLength)).toString('utf8');
            const port = (await read(2)).readUInt16BE(0);
            seen.push(`${host}:${port}`);
            const upstream = net.connect(port, host, () => {
                socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                upstream.pipe(socket);
                socket.pipe(upstream);
            });
            upstream.on('error', () => socket.destroy());
        })().catch(() => socket.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: (server.address() as AddressInfo).port,
        seen,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    };
}

describe('SOCKS5 tunnel', () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
        await applyProxy({ enabled: false, url: '' });
        for (const cleanup of cleanups.splice(0)) {
            await cleanup();
        }
    });

    /** HTTP origin the tunnel is asked to reach. */
    const startOrigin = async (): Promise<number> => {
        const origin = http.createServer((_request, response) => response.end('through-the-tunnel'));
        await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
        cleanups.push(async () => new Promise<void>(resolve => origin.close(() => resolve())));
        return (origin.address() as AddressInfo).port;
    };

    it('tunnels fetch() through the proxy, sending the hostname (remote DNS)', async () => {
        const originPort = await startOrigin();
        const proxy = await startSocks5Server();
        cleanups.push(proxy.close);

        await applyProxy({ enabled: true, url: `socks5h://127.0.0.1:${proxy.port}` });
        const response = await fetch(`http://127.0.0.1:${originPort}/page`);

        expect(await response.text()).toBe('through-the-tunnel');
        // the client sends the address to the proxy, which is the one dialing it
        expect(proxy.seen).toEqual([`127.0.0.1:${originPort}`]);
    });

    it('authenticates against a SOCKS5 proxy that requires credentials', async () => {
        const originPort = await startOrigin();
        const proxy = await startSocks5Server({ username: 'bot', password: 's3cret' });
        cleanups.push(proxy.close);

        await applyProxy({ enabled: true, url: `socks5://bot:s3cret@127.0.0.1:${proxy.port}` });
        const response = await fetch(`http://127.0.0.1:${originPort}/page`);

        expect(await response.text()).toBe('through-the-tunnel');
        expect(proxy.seen).toHaveLength(1);
    });

    it('fails when the credentials are rejected', async () => {
        const originPort = await startOrigin();
        const proxy = await startSocks5Server({ username: 'bot', password: 's3cret' });
        cleanups.push(proxy.close);

        await applyProxy({ enabled: true, url: `socks5://bot:wrong@127.0.0.1:${proxy.port}` });
        await expect(fetch(`http://127.0.0.1:${originPort}/page`)).rejects.toThrow();
        expect(proxy.seen).toHaveLength(0);
    });

    it('fails the request when nothing listens on the proxy port', async () => {
        const probe = net.createServer();
        await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
        const deadPort = (probe.address() as AddressInfo).port;
        await new Promise<void>(resolve => probe.close(() => resolve()));

        await applyProxy({ enabled: true, url: `socks5://127.0.0.1:${deadPort}` });
        await expect(fetch('http://example.invalid/')).rejects.toThrow();
    });
});
