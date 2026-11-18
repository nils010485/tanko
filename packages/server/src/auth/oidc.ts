import crypto from 'node:crypto';
import type { AuthUserDto } from '@tanko/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OidcConfig } from '../config.js';
import type { Database } from '../db.js';
import { directFetch } from '../util/proxy.js';

export const SESSION_COOKIE = 'tanko_session';
const TX_COOKIE = 'tanko_oidc_tx';
const TX_TTL_SECONDS = 600;
const MAX_PENDING_TX = 500;
const JWKS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const SUPPORTED_ALGS = new Map<string, { hash: string | null; padding?: number; dsaEncoding?: 'ieee-p1363' }>([
    ['RS256', { hash: 'sha256' }],
    ['RS384', { hash: 'sha384' }],
    ['RS512', { hash: 'sha512' }],
    ['PS256', { hash: 'sha256', padding: crypto.constants.RSA_PKCS1_PSS_PADDING }],
    ['PS384', { hash: 'sha384', padding: crypto.constants.RSA_PKCS1_PSS_PADDING }],
    ['PS512', { hash: 'sha512', padding: crypto.constants.RSA_PKCS1_PSS_PADDING }],
    ['ES256', { hash: 'sha256', dsaEncoding: 'ieee-p1363' }],
    ['ES384', { hash: 'sha384', dsaEncoding: 'ieee-p1363' }],
    ['ES512', { hash: 'sha512', dsaEncoding: 'ieee-p1363' }],
    ['EdDSA', { hash: null }]
]);

export interface OidcSession extends AuthUserDto {
    sub: string;
    exp: number;
}

interface DiscoveryDoc {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    userinfo_endpoint?: string;
    end_session_endpoint?: string;
}

interface JwkKey extends crypto.JsonWebKey {
    kid?: string;
    use?: string;
    alg?: string;
}

interface PendingTx {
    nonce: string;
    codeVerifier: string;
    redirectUri: string;
    returnTo: string;
    expiresAt: number;
}

interface IdTokenClaims {
    iss?: string;
    sub?: string;
    aud?: string | string[];
    azp?: string;
    exp?: number;
    nbf?: number;
    nonce?: string;
    name?: string;
    preferred_username?: string;
    email?: string;
    groups?: unknown;
}

function b64urlEncode(input: Buffer | string): string {
    return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
    return Buffer.from(input, 'base64url');
}

function safeEqualText(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!header) {
        return cookies;
    }
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const key = part.slice(0, eq).trim();
        const raw = part.slice(eq + 1).trim();
        try {
            cookies[key] = decodeURIComponent(raw);
        } catch {
            cookies[key] = raw;
        }
    }
    return cookies;
}

function signPayload(payload: object, secret: string): string {
    const body = b64urlEncode(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}

function verifySignedPayload<T extends { exp?: number }>(token: string, secret: string): T | null {
    const dot = token.indexOf('.');
    if (dot <= 0) {
        return null;
    }
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (!safeEqualText(sig, expected)) {
        return null;
    }
    try {
        const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as T;
        if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(Date.now() / 1000)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function sanitizeReturnTo(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
        return '/';
    }
    return raw;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(',')[0]?.trim() || undefined;
}

function isSecureRequest(request: FastifyRequest, publicUrl?: string): boolean {
    if (publicUrl?.startsWith('https://')) {
        return true;
    }
    if (firstHeader(request.headers['x-forwarded-proto']) === 'https') {
        return true;
    }
    return request.protocol === 'https';
}

function resolveOrigin(request: FastifyRequest, publicUrl?: string): string {
    if (publicUrl) {
        return publicUrl;
    }
    const proto = firstHeader(request.headers['x-forwarded-proto']);
    const scheme = proto === 'https' || proto === 'http' ? proto : request.protocol;
    const rawHost = firstHeader(request.headers['x-forwarded-host']) || request.headers.host || '';
    const host = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:\d+)?$/.test(rawHost) ? rawHost : 'localhost:8080';
    return `${scheme}://${host}`;
}

function formatCookie(name: string, value: string, maxAge: number, secure: boolean): string {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (secure) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

function appendSetCookie(reply: FastifyReply, cookie: string): void {
    const current = reply.getHeader('Set-Cookie');
    if (Array.isArray(current)) {
        reply.header('Set-Cookie', [...current.map(String), cookie]);
    } else if (typeof current === 'string') {
        reply.header('Set-Cookie', [current, cookie]);
    } else {
        reply.header('Set-Cookie', cookie);
    }
}

function resolveSessionSecret(db: Database, configured?: string): string {
    if (configured) {
        return configured;
    }
    const existing = db.kvGet('auth.sessionSecret');
    if (existing) {
        return existing;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    db.kvSet('auth.sessionSecret', generated);
    return generated;
}

function sameIssuer(a: string | undefined, b: string): boolean {
    return typeof a === 'string' && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export class OidcAuthService {
    private readonly secret: string;
    private readonly fetchImpl: typeof fetch;
    private readonly pending = new Map<string, PendingTx>();
    private discovery?: Promise<DiscoveryDoc>;
    private jwks?: { keys: JwkKey[]; fetchedAt: number };

    constructor(
        private readonly opts: {
            config: OidcConfig;
            db: Database;
            fetchImpl?: typeof fetch;
        }
    ) {
        this.secret = resolveSessionSecret(opts.db, opts.config.sessionSecret);
        this.fetchImpl = opts.fetchImpl ?? directFetch;
    }

    sessionFromHeaders(cookieHeader: string | undefined): OidcSession | null {
        const token = parseCookies(cookieHeader)[SESSION_COOKIE];
        if (!token) {
            return null;
        }
        const session = verifySignedPayload<OidcSession>(token, this.secret);
        if (!session || typeof session.sub !== 'string' || typeof session.name !== 'string') {
            return null;
        }
        return session;
    }

    sessionFromRequest(request: FastifyRequest): OidcSession | null {
        return this.sessionFromHeaders(request.headers.cookie);
    }

    async registerRoutes(app: FastifyInstance): Promise<void> {
        app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (request, reply) => {
            try {
                const discovery = await this.getDiscovery();
                const origin = resolveOrigin(request, this.opts.config.publicUrl);
                const redirectUri = `${origin}/auth/callback`;
                const state = b64urlEncode(crypto.randomBytes(24));
                const nonce = b64urlEncode(crypto.randomBytes(24));
                const codeVerifier = b64urlEncode(crypto.randomBytes(32));
                const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
                const returnTo = sanitizeReturnTo(request.query.returnTo);

                this.prunePending();
                this.pending.set(state, {
                    nonce,
                    codeVerifier,
                    redirectUri,
                    returnTo,
                    expiresAt: Date.now() + TX_TTL_SECONDS * 1000
                });

                const secure = isSecureRequest(request, this.opts.config.publicUrl);
                const txToken = signPayload({ state, exp: Math.floor(Date.now() / 1000) + TX_TTL_SECONDS }, this.secret);
                appendSetCookie(reply, formatCookie(TX_COOKIE, txToken, TX_TTL_SECONDS, secure));

                const url = new URL(discovery.authorization_endpoint);
                url.searchParams.set('response_type', 'code');
                url.searchParams.set('client_id', this.opts.config.clientId);
                url.searchParams.set('redirect_uri', redirectUri);
                url.searchParams.set('scope', this.opts.config.scopes);
                url.searchParams.set('state', state);
                url.searchParams.set('nonce', nonce);
                url.searchParams.set('code_challenge', codeChallenge);
                url.searchParams.set('code_challenge_method', 'S256');
                return reply.redirect(url.href);
            } catch (error) {
                console.error('[auth] login init failed:', (error as Error).message);
                return reply.redirect('/?auth_error=unavailable');
            }
        });

        app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/callback', async (request, reply) => {
            const secure = isSecureRequest(request, this.opts.config.publicUrl);
            appendSetCookie(reply, formatCookie(TX_COOKIE, '', 0, secure));

            if (request.query.error) {
                return reply.redirect('/?auth_error=provider');
            }
            const { code, state } = request.query;
            if (!code || !state) {
                return reply.redirect('/?auth_error=invalid_callback');
            }
            const txToken = parseCookies(request.headers.cookie)[TX_COOKIE];
            const txCookie = txToken ? verifySignedPayload<{ state?: string; exp?: number }>(txToken, this.secret) : null;
            const tx = this.pending.get(state);
            this.pending.delete(state);

            if (!tx || tx.expiresAt <= Date.now() || !txCookie?.state || !safeEqualText(txCookie.state, state)) {
                return reply.redirect('/?auth_error=invalid_state');
            }

            try {
                const discovery = await this.getDiscovery();
                const tokens = await this.exchangeCode(discovery.token_endpoint, code, tx.codeVerifier, tx.redirectUri);
                const claims = await this.verifyIdToken(discovery, tokens.id_token, tx.nonce);
                const merged = await this.enrichWithUserInfo(discovery, tokens.access_token, claims);

                if (!this.isGroupAllowed(merged.groups)) {
                    return reply.redirect('/?auth_error=forbidden');
                }

                const nowSec = Math.floor(Date.now() / 1000);
                const session: OidcSession = {
                    sub: String(merged.sub),
                    name: merged.name || merged.preferred_username || merged.email || String(merged.sub),
                    email: merged.email || undefined,
                    exp: nowSec + this.opts.config.sessionTtlSeconds
                };
                appendSetCookie(reply, formatCookie(SESSION_COOKIE, signPayload(session, this.secret), this.opts.config.sessionTtlSeconds, secure));
                return reply.redirect(tx.returnTo);
            } catch (error) {
                console.error('[auth] callback failed:', (error as Error).message);
                return reply.redirect('/?auth_error=failed');
            }
        });

        app.post('/api/auth/logout', async (request, reply) => {
            const secure = isSecureRequest(request, this.opts.config.publicUrl);
            appendSetCookie(reply, formatCookie(SESSION_COOKIE, '', 0, secure));
            let logoutUrl: string | undefined;
            try {
                const discovery = await this.getDiscovery();
                if (discovery.end_session_endpoint) {
                    const url = new URL(discovery.end_session_endpoint);
                    url.searchParams.set('post_logout_redirect_uri', resolveOrigin(request, this.opts.config.publicUrl));
                    url.searchParams.set('client_id', this.opts.config.clientId);
                    logoutUrl = url.href;
                }
            } catch {
                // local cookie cleared regardless
            }
            return { ok: true, logoutUrl };
        });
    }

    private prunePending(): void {
        const now = Date.now();
        for (const [key, value] of this.pending) {
            if (value.expiresAt <= now) {
                this.pending.delete(key);
            }
        }
        while (this.pending.size >= MAX_PENDING_TX) {
            const oldest = this.pending.keys().next().value;
            if (!oldest) {
                break;
            }
            this.pending.delete(oldest);
        }
    }

    private async getDiscovery(): Promise<DiscoveryDoc> {
        if (!this.discovery) {
            const url = `${this.opts.config.issuer}/.well-known/openid-configuration`;
            this.discovery = this.fetchJson<DiscoveryDoc>(url).then(doc => {
                if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
                    throw new Error('incomplete OIDC discovery document');
                }
                return doc;
            });
            this.discovery.catch(() => {
                this.discovery = undefined;
            });
        }
        return this.discovery;
    }

    private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
        const response = await this.fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${url}`);
        }
        return (await response.json()) as T;
    }

    private async exchangeCode(
        tokenEndpoint: string,
        code: string,
        codeVerifier: string,
        redirectUri: string
    ): Promise<{ id_token: string; access_token?: string }> {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: this.opts.config.clientId,
            code_verifier: codeVerifier
        });
        if (this.opts.config.clientSecret) {
            body.set('client_secret', this.opts.config.clientSecret);
        }
        const tokens = await this.fetchJson<{ id_token?: string; access_token?: string }>(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: body.toString()
        });
        if (!tokens.id_token) {
            throw new Error('token response missing id_token');
        }
        return { id_token: tokens.id_token, access_token: tokens.access_token };
    }

    private async getJwks(jwksUri: string, forceRefresh = false): Promise<JwkKey[]> {
        if (!forceRefresh && this.jwks && Date.now() - this.jwks.fetchedAt < JWKS_TTL_MS) {
            return this.jwks.keys;
        }
        const data = await this.fetchJson<{ keys?: JwkKey[] }>(jwksUri);
        const keys = Array.isArray(data.keys) ? data.keys : [];
        this.jwks = { keys, fetchedAt: Date.now() };
        return keys;
    }

    private async verifyIdToken(discovery: DiscoveryDoc, idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
        const parts = idToken.split('.');
        if (parts.length !== 3) {
            throw new Error('malformed id_token');
        }
        const [rawHeader, rawPayload, rawSig] = parts;
        const header = JSON.parse(b64urlDecode(rawHeader).toString('utf8')) as { alg?: string; kid?: string };
        const algSpec = header.alg ? SUPPORTED_ALGS.get(header.alg) : undefined;
        if (!algSpec) {
            throw new Error(`unsupported id_token alg "${String(header.alg)}"`);
        }

        let keys = await this.getJwks(discovery.jwks_uri);
        let jwk = keys.find(key => (!header.kid || key.kid === header.kid) && (!key.use || key.use === 'sig'));
        if (!jwk && header.kid) {
            keys = await this.getJwks(discovery.jwks_uri, true);
            jwk = keys.find(key => key.kid === header.kid && (!key.use || key.use === 'sig'));
        }
        if (!jwk) {
            throw new Error('matching JWK not found');
        }

        const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
        const signature = b64urlDecode(rawSig);
        const verified = crypto.verify(algSpec.hash, signingInput, { key: publicKey, padding: algSpec.padding, dsaEncoding: algSpec.dsaEncoding }, signature);
        if (!verified) {
            throw new Error('invalid id_token signature');
        }

        const claims = JSON.parse(b64urlDecode(rawPayload).toString('utf8')) as IdTokenClaims;
        const now = Math.floor(Date.now() / 1000);
        if (!sameIssuer(claims.iss, discovery.issuer)) {
            throw new Error('invalid id_token issuer');
        }
        const audList = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
        if (!audList.includes(this.opts.config.clientId)) {
            throw new Error('invalid id_token audience');
        }
        if (audList.length > 1 && claims.azp !== this.opts.config.clientId) {
            throw new Error('invalid id_token azp');
        }
        if (typeof claims.exp !== 'number' || claims.exp <= now - 60) {
            throw new Error('expired id_token');
        }
        if (typeof claims.nbf === 'number' && claims.nbf > now + 60) {
            throw new Error('id_token not yet valid');
        }
        if (typeof claims.nonce !== 'string' || !safeEqualText(claims.nonce, expectedNonce)) {
            throw new Error('invalid id_token nonce');
        }
        if (!claims.sub) {
            throw new Error('id_token missing sub');
        }
        return claims;
    }

    private async enrichWithUserInfo(discovery: DiscoveryDoc, accessToken: string | undefined, claims: IdTokenClaims): Promise<IdTokenClaims> {
        const needsGroups = this.opts.config.allowedGroups.length > 0 && !Array.isArray(claims.groups);
        const needsProfile = !claims.name && !claims.preferred_username && !claims.email;
        if (!accessToken || !discovery.userinfo_endpoint || (!needsGroups && !needsProfile)) {
            return claims;
        }
        try {
            const info = await this.fetchJson<IdTokenClaims>(discovery.userinfo_endpoint, {
                headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
            });
            return { ...info, ...claims, groups: claims.groups ?? info.groups };
        } catch {
            return claims;
        }
    }

    private isGroupAllowed(groupsClaim: unknown): boolean {
        const allowed = this.opts.config.allowedGroups;
        if (allowed.length === 0) {
            return true;
        }
        if (!Array.isArray(groupsClaim)) {
            return false;
        }
        return groupsClaim.some(group => typeof group === 'string' && allowed.includes(group));
    }
}
