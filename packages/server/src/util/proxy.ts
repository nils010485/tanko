/**
 * Optional outbound proxy for every fetch() the server makes (sources,
 * downloads, covers, webhooks…): SOCKS5 (with or without auth), HTTP/HTTPS
 * CONNECT, and gost's multiplexed HTTP/2 tunnel.
 *
 * The active proxy is a module-level dispatcher that PATCH /api/settings swaps
 * live - no restart needed, and the next request picks up the new tunnel.
 */
import { once } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { ProxySettingsDto, ProxyTestResultDto } from '@tanko/shared';
import { type Dispatcher, ProxyAgent } from 'undici';

export type ProxyProtocol = 'socks5' | 'http' | 'https' | 'http2';

export interface ProxyConfig {
    protocol: ProxyProtocol;
    host: string;
    port: number;
    username?: string;
    password?: string;
}

const DEFAULT_PORTS: Record<ProxyProtocol, number> = { socks5: 1080, http: 8080, https: 443, http2: 443 };

/** URL scheme → protocol. 'socks5h' is the remote-DNS flavour of SOCKS5 and
 *  'h2' gost's HTTP/2 listener: both are the shapes clients actually ship. */
const SCHEMES: Record<string, ProxyProtocol> = {
    socks: 'socks5',
    socks5: 'socks5',
    socks5h: 'socks5',
    http: 'http',
    https: 'https',
    h2: 'http2',
    http2: 'http2'
};

/** 15 s is generous for a handshake and keeps a dead proxy from stalling a download. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Drop an HTTP/2 proxy session idle for that long: a half-dead one would
 *  silently stall the next tunnel, a reconnect costs one round trip. */
const H2_IDLE_TIMEOUT_MS = 90_000;
const PROBE_URL = 'https://api.ipify.org?format=json';
const PROBE_TIMEOUT_MS = 20_000;

const SOCKS5_ERRORS: Record<number, string> = {
    1: 'general SOCKS server failure',
    2: 'connection not allowed by ruleset',
    3: 'network unreachable',
    4: 'host unreachable',
    5: 'connection refused by destination',
    6: 'TTL expired',
    7: 'command not supported',
    8: 'address type not supported'
};

/** Parse 'socks5h://user:pass@host:port' into its parts (scheme decides the default port). */
export function parseProxyUrl(raw: string): ProxyConfig {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error('Proxy URL is empty');
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new Error(`Invalid proxy URL: ${trimmed}`);
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    const protocol = SCHEMES[scheme];
    if (!protocol) {
        throw new Error(`Unsupported proxy scheme "${scheme}" (use socks5://, http://, https:// or http2://)`);
    }
    if (!url.hostname) {
        throw new Error('Proxy URL has no host');
    }
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[protocol];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid proxy port: ${url.port}`);
    }
    return {
        protocol,
        host: url.hostname.replace(/^\[(.+)\]$/, '$1'),
        port,
        // '' (no userinfo) and 'anonymous' are different: keep undefined when absent
        username: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.username ? decodeURIComponent(url.password) : undefined
    };
}

/** Host, re-bracketed for IPv6 literals when embedded in a URL or authority. */
function authorityHost(host: string): string {
    return net.isIPv6(host) ? `[${host}]` : host;
}

function basicAuth(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Read from a paused socket until `size` bytes are available (handshake
 *  exchange); pauses stay in place, so the tunnel's first bytes are not lost. */
function createReader(socket: net.Socket) {
    let pending = Buffer.alloc(0);
    const readChunk = async (signal: AbortSignal): Promise<Buffer> => {
        for (;;) {
            const chunk = socket.read() as Buffer | null;
            if (chunk?.length) {
                return chunk;
            }
            if (socket.destroyed) {
                throw new Error('Proxy closed the connection');
            }
            await once(socket, 'readable', { signal });
        }
    };
    return {
        async read(size: number, signal: AbortSignal): Promise<Buffer> {
            while (pending.length < size) {
                pending = Buffer.concat([pending, await readChunk(signal)]);
            }
            const out = pending.subarray(0, size);
            pending = pending.subarray(size);
            return out;
        },
        /** Hand any over-read back to the socket before the relay pipes it. */
        flush(): void {
            if (pending.length) {
                socket.unshift(pending);
                pending = Buffer.alloc(0);
            }
        }
    };
}

async function connectSocket(host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    try {
        await once(socket, 'connect', { signal });
    } catch (error) {
        socket.destroy();
        throw new Error(`Cannot reach the proxy at ${host}:${port}: ${describeError(error)}`);
    }
    return socket;
}

/** SOCKS5 (RFC 1928/1929) with the hostname sent as-is: the proxy resolves it,
 *  so the DNS query never leaves the tunnel. */
async function openSocks5Tunnel(config: ProxyConfig, host: string, port: number): Promise<net.Socket> {
    const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
    const socket = await connectSocket(config.host, config.port, signal);
    const reader = createReader(socket);
    try {
        const user = config.username === undefined ? null : Buffer.from(config.username, 'utf8');
        const password = Buffer.from(config.password ?? '', 'utf8');
        if (user && (user.length > 255 || password.length > 255)) {
            throw new Error('SOCKS5 credentials are longer than 255 bytes');
        }
        socket.write(Buffer.from(user ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
        const [version, method] = await reader.read(2, signal);
        if (version !== 0x05) {
            throw new Error('Not a SOCKS5 proxy');
        }
        if (method === 0xff) {
            throw new Error('SOCKS5 proxy refused the offered authentication methods');
        }
        if (method === 0x02) {
            if (!user) {
                throw new Error('SOCKS5 proxy requires a username and password');
            }
            socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([password.length]), password]));
            const [, status] = await reader.read(2, signal);
            if (status !== 0x00) {
                throw new Error('SOCKS5 authentication failed');
            }
        } else if (method !== 0x00) {
            throw new Error(`Unsupported SOCKS5 authentication method ${method}`);
        }
        const target = Buffer.from(host, 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, target.length]), target, Buffer.from([port >> 8, port & 0xff])]));
        const reply = await reader.read(4, signal);
        if (reply[1] !== 0x00) {
            throw new Error(`SOCKS5 refused the tunnel: ${SOCKS5_ERRORS[reply[1]] ?? `error ${reply[1]}`}`);
        }
        // drain the bound address before handing the socket over
        const family = reply[3];
        let addressLength = 0;
        if (family === 0x01) {
            addressLength = 4;
        } else if (family === 0x03) {
            addressLength = (await reader.read(1, signal))[0];
        } else if (family === 0x04) {
            addressLength = 16;
        } else {
            throw new Error(`Unsupported SOCKS5 address type ${family}`);
        }
        await reader.read(addressLength + 2, signal);
    } catch (error) {
        socket.destroy();
        throw error;
    }
    reader.flush();
    return socket;
}

/** One TLS+HTTP/2 session per proxy, shared by every tunnel: that multiplexing
 *  is the entire point of the gost http2 listener (no handshake per request). */
let h2Session: http2.ClientHttp2Session | null = null;
let h2SessionKey = '';

function closeHttp2Session(): void {
    h2Session?.destroy();
    h2Session = null;
    h2SessionKey = '';
}

function http2SessionFor(config: ProxyConfig): http2.ClientHttp2Session {
    const key = `${config.host}:${config.port}:${config.username ?? ''}`;
    if (h2Session && h2SessionKey === key && !h2Session.closed && !h2Session.destroyed) {
        return h2Session;
    }
    closeHttp2Session();
    const session = http2.connect(`https://${authorityHost(config.host)}:${config.port}`, { servername: config.host });
    const drop = () => {
        if (h2Session === session) {
            closeHttp2Session();
        }
    };
    session.on('error', drop);
    session.on('close', drop);
    session.on('goaway', drop);
    session.setTimeout(H2_IDLE_TIMEOUT_MS, drop);
    h2Session = session;
    h2SessionKey = key;
    return session;
}

/** gost 'http2' handler: CONNECT as an HTTP/2 stream, authenticated with the
 *  standard Proxy-Authorization header (gost's auther plugin). */
async function openHttp2Tunnel(config: ProxyConfig, host: string, port: number): Promise<Duplex> {
    const session = http2SessionFor(config);
    const signal = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS);
    if (session.connecting) {
        await once(session, 'connect', { signal });
    }
    const target = `${authorityHost(host)}:${port}`;
    // CONNECT carries the target in :authority only (:path is forbidden there)
    const headers: http2.OutgoingHttpHeaders = { ':method': 'CONNECT', ':authority': target };
    if (config.username !== undefined) {
        headers['proxy-authorization'] = basicAuth(config.username, config.password ?? '');
    }
    const stream = session.request(headers);
    try {
        const [response] = await once(stream, 'response', { signal });
        const status = Number(response[':status']);
        if (status === 407) {
            throw new Error('HTTP/2 proxy authentication failed');
        }
        if (status !== 200) {
            throw new Error(`HTTP/2 proxy refused the tunnel (HTTP ${status})`);
        }
    } catch (error) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        throw error;
    }
    return stream;
}

interface Relay {
    url: string;
    lastError: () => string | null;
    close: () => Promise<void>;
}

/** Split 'host:port' / '[::1]:port' as sent in a CONNECT line. */
function parseAuthority(authority: string): { host: string; port: number } | null {
    const match = /^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/.exec(authority);
    if (!match) {
        return null;
    }
    const port = Number(match[2] ?? match[4]);
    const host = match[1] ?? match[3];
    return host && Number.isInteger(port) ? { host, port } : null;
}

/**
 * Loopback CONNECT relay: undici's ProxyAgent only speaks HTTP tunnels, so
 * SOCKS5 and HTTP/2 get their own handshake here and undici just opens
 * CONNECTs against this local port.
 */
async function startRelay(openTunnel: (host: string, port: number) => Promise<Duplex>): Promise<Relay> {
    const sockets = new Set<Duplex>();
    let lastError: string | null = null;

    /** Dial through the real proxy, then splice both sockets together. */
    async function handleConnect(request: http.IncomingMessage, clientSocket: Duplex, head: Buffer): Promise<void> {
        clientSocket.on('error', () => undefined);
        const target = parseAuthority(request.url ?? '');
        if (!target) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            return;
        }
        try {
            const tunnel = await openTunnel(target.host, target.port);
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) {
                tunnel.write(head);
            }
            tunnel.on('error', () => clientSocket.destroy());
            clientSocket.on('close', () => tunnel.destroy());
            tunnel.pipe(clientSocket);
            clientSocket.pipe(tunnel);
        } catch (error) {
            // undici discards the 502 body, so the reason is kept here for the probe
            lastError = describeError(error);
            clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
    }

    const server = http.createServer((_request, response) => {
        response.writeHead(405).end();
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('connect', (request, clientSocket, head) => {
        void handleConnect(request, clientSocket, head);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Cannot start the proxy relay');
    }
    return {
        url: `http://127.0.0.1:${address.port}`,
        lastError: () => lastError,
        close: async () => {
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    };
}

export interface ProxyRuntime {
    dispatcher: Dispatcher;
    /** Last tunnel handshake failure (SOCKS5/HTTP2), for actionable probe errors. */
    lastError?: () => string | null;
    close: () => Promise<void>;
}

/** Build the dispatcher for one proxy URL (HTTP(S) proxies are handed straight
 *  to undici; SOCKS5 and HTTP/2 go through the loopback relay). */
export async function createProxyRuntime(config: ProxyConfig): Promise<ProxyRuntime> {
    if (config.protocol === 'http' || config.protocol === 'https') {
        const credentials = config.username === undefined ? '' : `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password ?? '')}@`;
        const dispatcher = new ProxyAgent({ uri: `${config.protocol}://${credentials}${authorityHost(config.host)}:${config.port}` });
        return { dispatcher, close: () => dispatcher.close() };
    }
    const relay = await startRelay((host, port) => (config.protocol === 'socks5' ? openSocks5Tunnel(config, host, port) : openHttp2Tunnel(config, host, port)));
    const dispatcher = new ProxyAgent({ uri: relay.url, proxyTunnel: true });
    return {
        dispatcher,
        lastError: relay.lastError,
        close: async () => {
            await dispatcher.close();
            await relay.close();
            if (config.protocol === 'http2') {
                closeHttp2Session();
            }
        }
    };
}

let active: { key: string; runtime: ProxyRuntime } | null = null;

/** Activate (or clear) the outbound proxy for every later fetch().
 *  A disabled or empty setting means a direct connection. */
export async function applyProxy(settings?: Partial<ProxySettingsDto>): Promise<void> {
    const url = settings?.enabled === true ? (settings.url ?? '').trim() : '';
    if ((active?.key ?? '') === url) {
        return;
    }
    // build first: a bad URL must leave the previous proxy running
    const next = url ? { key: url, runtime: await createProxyRuntime(parseProxyUrl(url)) } : null;
    const previous = active;
    active = next;
    await previous?.runtime.close();
}

/** Active proxy URL, or null when requests go out directly. */
export function activeProxy(): string | null {
    return active?.key ?? null;
}

const nativeFetch = globalThis.fetch;
let installed = false;

/** Route every subsequent global fetch() through the active proxy: a single
 *  hook covers sources, downloads, covers, webhooks and the pack updater.
 *  (Requests issued by the embedded Chromium are not affected.) */
export function installProxyFetch(): void {
    if (installed) {
        return;
    }
    installed = true;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const dispatcher = active?.runtime.dispatcher;
        return dispatcher ? nativeFetch(input, { ...init, dispatcher } as RequestInit) : nativeFetch(input, init);
    }) as typeof fetch;
}

/** Deepest message of the cause chain: 'fetch failed' sits on top of the real reason. */
function describeError(error: unknown): string {
    let current: unknown = error;
    let message = '';
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
        message = current.message || message;
        current = current.cause;
    }
    return message || String(error);
}

/**
 * Probe a proxy (a candidate URL, or the active one when omitted): one request
 * to a public echo service, reporting the exit IP and the round-trip time.
 * Goes through the raw fetch so it never re-enters the active dispatcher.
 */
export async function testProxy(raw?: string): Promise<ProxyTestResultDto> {
    const candidate = (raw ?? '').trim();
    const started = performance.now();
    let runtime: ProxyRuntime | null = null;
    try {
        let dispatcher = active?.runtime.dispatcher ?? null;
        if (candidate) {
            runtime = await createProxyRuntime(parseProxyUrl(candidate));
            dispatcher = runtime.dispatcher;
        }
        const response = await nativeFetch(PROBE_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
        const ms = Math.round(performance.now() - started);
        if (!response.ok) {
            return { ok: false, ms, error: `HTTP ${response.status}` };
        }
        const body = (await response.json().catch(() => null)) as { ip?: string } | null;
        return { ok: true, ms, ip: body?.ip };
    } catch (error) {
        // a failed handshake is reported by the relay: undici only sees the 502
        const tunnelError = (runtime?.lastError ?? active?.runtime.lastError)?.();
        return { ok: false, ms: Math.round(performance.now() - started), error: tunnelError ?? describeError(error) };
    } finally {
        await runtime?.close();
    }
}
