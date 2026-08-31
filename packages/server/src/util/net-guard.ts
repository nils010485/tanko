/**
 * Outbound proxy guard: blocks private/loopback/link-local targets (SSRF),
 * re-validates redirect hops and caps response bodies.
 */

import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

// IPv4: this-network, private, CGNAT, loopback, link-local (incl. cloud
// metadata), benchmark, reserved
const BLOCKED_V4 = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '240.0.0.0/4'
];
// IPv6: unspecified, loopback, unique-local, link-local, NAT64, 6to4
const BLOCKED_V6 = ['::/128', '::1/128', '64:ff9b::/96', '2002::/16', 'fc00::/7', 'fe80::/10'];

function buildBlockList(subnets: string[], family: 'ipv4' | 'ipv6'): net.BlockList {
    const list = new net.BlockList();
    for (const subnet of subnets) {
        const [address, bits] = subnet.split('/');
        list.addSubnet(address, Number(bits), family);
    }
    return list;
}

const v4List = buildBlockList(BLOCKED_V4, 'ipv4');
const v6List = buildBlockList(BLOCKED_V6, 'ipv6');

export function isPrivateAddress(address: string): boolean {
    if (net.isIPv4(address)) {
        return v4List.check(address, 'ipv4');
    }
    if (!net.isIPv6(address)) {
        return false;
    }
    // IPv4-mapped: ::ffff:10.0.0.5 (dotted) or ::ffff:a00:5 (hex, WHATWG
    // URL serializes to hex) — check the embedded IPv4 instead
    const embedded = address.match(/^::ffff:(.+)$/i);
    if (embedded) {
        const tail = embedded[1];
        if (net.isIPv4(tail)) {
            return v4List.check(tail, 'ipv4');
        }
        const groups = tail.split(':');
        if (groups.length === 2) {
            const high = Number.parseInt(groups[0], 16);
            const low = Number.parseInt(groups[1], 16);
            if (Number.isFinite(high) && Number.isFinite(low)) {
                return v4List.check(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`, 'ipv4');
            }
        }
        return true; // malformed mapped form: refuse
    }
    return v6List.check(address, 'ipv6');
}

/** Resolve a hostname and reject when ANY resolved address is private
 *  (a public name with one private A/AAAA record is still a rebinding probe). */
export async function assertPublicHost(hostname: string): Promise<void> {
    // URL.hostname keeps IPv6 literals bracketed ([::1]) — net.isIP doesn't parse those
    const host = hostname.replace(/^\[(.+)\]$/, '$1');
    if (net.isIP(host) !== 0) {
        if (isPrivateAddress(host)) {
            throw new Error(`Blocked private address: ${host}`);
        }
        return;
    }
    let records: LookupAddress[];
    try {
        records = await dns.lookup(hostname, { all: true });
    } catch {
        throw new Error(`Cannot resolve host: ${hostname}`);
    }
    for (const { address } of records) {
        if (isPrivateAddress(address)) {
            throw new Error(`Blocked private address for ${hostname}: ${address}`);
        }
    }
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
    const target = new URL(raw);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('Only http(s) URLs are allowed');
    }
    await assertPublicHost(target.hostname);
    return target;
}

const MAX_REDIRECTS = 5;

/** fetch() that re-validates the target of every redirect hop against the
 *  private-range blocklist (redirect: 'manual' + explicit hop loop).
 *
 * NB: a TOCTOU remains between the dns.lookup here and undici's own
 * resolution at connect time (DNS rebinding) — accepted residual, see the
 * audit report. */
export async function fetchGuarded(raw: string, init: RequestInit = {}): Promise<Response> {
    let target = await assertPublicHttpUrl(raw);
    for (let hop = 0; ; hop++) {
        const headers = new Headers(init.headers);
        if (hop > 0 && headers.has('referer')) {
            // browser-like: after a hop, the Referer is the redirecting page's
            // origin — the caller's first-hop Referer (source URL) is preserved
            headers.set('referer', `${target.origin}/`);
        }
        const response = await fetch(target, { ...init, headers, redirect: 'manual', signal: init.signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
            return response;
        }
        // release the socket before following the hop
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) {
            return response;
        }
        if (hop >= MAX_REDIRECTS) {
            throw new Error('Too many redirects');
        }
        target = await assertPublicHttpUrl(new URL(location, target).href);
    }
}

/** Read a response body as a Buffer, aborting as soon as maxBytes is exceeded. */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Response too large (${declared} bytes)`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (!response.body) {
        return Buffer.alloc(0);
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
            await response.body.cancel().catch(() => undefined);
            throw new Error('Response too large');
        }
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
