import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOKEN_HEADER } from '@tanko/shared';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OidcAuthService, SESSION_COOKIE } from '../src/auth/oidc.js';
import type { OidcConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { registerHealthRoutes } from '../src/routes/health.js';
import { apiToken, registerTokenGuard } from '../src/util/token-guard.js';

let tmpDir: string;
let database: Database;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'test-key-1', use: 'sig', alg: 'RS256' };
const ISSUER = 'https://auth.example.com/application/o/tanko';

function signJwt(payload: object, alg: 'RS256' | 'none' = 'RS256'): string {
    const header = Buffer.from(JSON.stringify(alg === 'none' ? { alg: 'none' } : { alg: 'RS256', kid: 'test-key-1', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    if (alg === 'none') {
        return `${header}.${body}.`;
    }
    const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`, 'utf8'), privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
}

function cookiePair(setCookies: string | string[] | undefined, name: string): string | undefined {
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
    for (const raw of list) {
        const pair = raw.split(';', 1)[0];
        if (pair.startsWith(`${name}=`)) {
            return pair;
        }
    }
    return undefined;
}

function createMockFetch(claimsFactory: (nonce: string) => Record<string, unknown>, userInfoClaims?: Record<string, unknown>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${ISSUER}/.well-known/openid-configuration`) {
            return new Response(
                JSON.stringify({
                    issuer: ISSUER,
                    authorization_endpoint: `${ISSUER}/authorize`,
                    token_endpoint: `${ISSUER}/token`,
                    jwks_uri: `${ISSUER}/jwks`,
                    userinfo_endpoint: `${ISSUER}/userinfo`,
                    end_session_endpoint: `${ISSUER}/end-session`
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }
        if (url === `${ISSUER}/jwks`) {
            return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === `${ISSUER}/token`) {
            const params = new URLSearchParams(String(init?.body || ''));
            const code = params.get('code') || '';
            const verifier = params.get('code_verifier') || '';
            const [nonce, expectedChallenge] = code.split(':');
            const actualChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
            if (actualChallenge !== expectedChallenge) {
                return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
            }
            const now = Math.floor(Date.now() / 1000);
            const idToken = signJwt({
                iss: ISSUER,
                sub: 'user-123',
                aud: 'tanko-client',
                exp: now + 300,
                iat: now,
                nonce,
                ...claimsFactory(nonce)
            });
            return new Response(JSON.stringify({ id_token: idToken, access_token: 'access-abc' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (url === `${ISSUER}/userinfo`) {
            return new Response(JSON.stringify(userInfoClaims ?? { sub: 'user-123' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response('not found', { status: 404 });
    }) as typeof fetch;
}

async function buildApp(overrides: Partial<OidcConfig> = {}, mockFetch?: typeof fetch) {
    const app = Fastify();
    const config: OidcConfig = {
        issuer: ISSUER,
        clientId: 'tanko-client',
        clientSecret: 'tanko-secret',
        scopes: 'openid profile email groups',
        allowedGroups: [],
        sessionTtlSeconds: 3600,
        sessionSecret: 'test-session-secret-0123456789abcdef',
        ...overrides
    };
    const auth = new OidcAuthService({ config, db: database, fetchImpl: mockFetch });
    registerTokenGuard(app, auth);
    registerHealthRoutes(app);
    await auth.registerRoutes(app);
    app.get('/api/library', async () => ({ entries: [] }));
    app.post('/api/mutate', async () => ({ ok: true }));
    await app.ready();
    return { app, auth };
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-oidc-'));
    database = new Database(tmpDir);
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OIDC optional SSO', () => {
    it('blocks /api/* and /api/bootstrap until authenticated while keeping /health public', async () => {
        const { app } = await buildApp(
            {},
            createMockFetch(() => ({ name: 'Alice', email: 'alice@example.com' }))
        );
        try {
            const health = await app.inject({ method: 'GET', url: '/health' });
            expect(health.statusCode).toBe(200);

            const boot = await app.inject({ method: 'GET', url: '/api/bootstrap' });
            expect(boot.statusCode).toBe(401);
            expect(boot.json()).toEqual({ error: 'Authentication required', authEnabled: true });

            const apiGet = await app.inject({ method: 'GET', url: '/api/library' });
            expect(apiGet.statusCode).toBe(401);

            const apiPost = await app.inject({ method: 'POST', url: '/api/mutate', headers: { [TOKEN_HEADER]: apiToken } });
            expect(apiPost.statusCode).toBe(401);
        } finally {
            await app.close();
        }
    });

    it('completes PKCE login, sets HttpOnly session cookie, and rejects tampered cookies', async () => {
        const { app, auth } = await buildApp(
            {},
            createMockFetch(() => ({ name: 'Alice', email: 'alice@example.com' }))
        );
        try {
            const login = await app.inject({ method: 'GET', url: '/auth/login?returnTo=//evil.example.com', headers: { host: 'tanko.local' } });
            expect(login.statusCode).toBe(302);
            const redirectUrl = new URL(login.headers.location as string);
            expect(redirectUrl.origin + redirectUrl.pathname).toBe(`${ISSUER}/authorize`);
            const state = redirectUrl.searchParams.get('state')!;
            const nonce = redirectUrl.searchParams.get('nonce')!;
            const challenge = redirectUrl.searchParams.get('code_challenge')!;
            const txCookie = cookiePair(login.headers['set-cookie'], 'tanko_oidc_tx')!;
            expect(txCookie).toBeDefined();

            const cb = await app.inject({
                method: 'GET',
                url: `/auth/callback?code=${encodeURIComponent(`${nonce}:${challenge}`)}&state=${encodeURIComponent(state)}`,
                headers: { host: 'tanko.local', cookie: txCookie }
            });
            expect(cb.statusCode).toBe(302);
            // open-redirect attempt sanitized to '/'
            expect(cb.headers.location).toBe('/');
            const sessionCookie = cookiePair(cb.headers['set-cookie'], SESSION_COOKIE)!;
            expect(sessionCookie).toBeDefined();
            expect(auth.sessionFromHeaders(sessionCookie)?.name).toBe('Alice');

            // authenticated bootstrap + GET + POST
            const boot = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { cookie: sessionCookie } });
            expect(boot.statusCode).toBe(200);
            expect(boot.json()).toEqual({ token: apiToken, authEnabled: true, user: { name: 'Alice', email: 'alice@example.com' } });

            const apiGet = await app.inject({ method: 'GET', url: '/api/library', headers: { cookie: sessionCookie } });
            expect(apiGet.statusCode).toBe(200);

            // CSRF guard still blocks POST without x-tanko-token even when authenticated
            const noCsrf = await app.inject({ method: 'POST', url: '/api/mutate', headers: { cookie: sessionCookie } });
            expect(noCsrf.statusCode).toBe(403);

            const okPost = await app.inject({ method: 'POST', url: '/api/mutate', headers: { cookie: sessionCookie, [TOKEN_HEADER]: apiToken } });
            expect(okPost.statusCode).toBe(200);

            // tampered session cookie rejected
            const tampered = await app.inject({ method: 'GET', url: '/api/library', headers: { cookie: `${sessionCookie}x` } });
            expect(tampered.statusCode).toBe(401);

            // logout clears cookie and returns end_session_endpoint
            const logout = await app.inject({
                method: 'POST',
                url: '/api/auth/logout',
                headers: { cookie: sessionCookie, [TOKEN_HEADER]: apiToken, host: 'tanko.local' }
            });
            expect(logout.statusCode).toBe(200);
            expect(logout.json().logoutUrl).toContain(`${ISSUER}/end-session`);
            expect(String(logout.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
        } finally {
            await app.close();
        }
    });

    it('rejects replayed or mismatched OIDC state and alg=none tokens', async () => {
        const { app } = await buildApp(
            {},
            createMockFetch(() => ({ name: 'Alice' }))
        );
        try {
            const login = await app.inject({ method: 'GET', url: '/auth/login', headers: { host: 'tanko.local' } });
            const redirectUrl = new URL(login.headers.location as string);
            const state = redirectUrl.searchParams.get('state')!;
            const nonce = redirectUrl.searchParams.get('nonce')!;
            const challenge = redirectUrl.searchParams.get('code_challenge')!;
            const txCookie = cookiePair(login.headers['set-cookie'], 'tanko_oidc_tx')!;

            // missing tx cookie -> rejected
            const noCookie = await app.inject({
                method: 'GET',
                url: `/auth/callback?code=${encodeURIComponent(`${nonce}:${challenge}`)}&state=${encodeURIComponent(state)}`
            });
            expect(noCookie.statusCode).toBe(302);
            expect(noCookie.headers.location).toBe('/?auth_error=invalid_state');

            // replay after failed attempt -> state already consumed
            const replay = await app.inject({
                method: 'GET',
                url: `/auth/callback?code=${encodeURIComponent(`${nonce}:${challenge}`)}&state=${encodeURIComponent(state)}`,
                headers: { cookie: txCookie }
            });
            expect(replay.headers.location).toBe('/?auth_error=invalid_state');
        } finally {
            await app.close();
        }

        // alg: none token rejected
        const baseFetch = createMockFetch(() => ({}));
        const algNoneFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === `${ISSUER}/token`) {
                return new Response(JSON.stringify({ id_token: signJwt({ iss: ISSUER, sub: 'x', aud: 'tanko-client', exp: 9999999999 }, 'none') }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return baseFetch(input, init);
        }) as typeof fetch;
        const { app: app2 } = await buildApp({}, algNoneFetch);
        try {
            const login = await app2.inject({ method: 'GET', url: '/auth/login', headers: { host: 'tanko.local' } });
            const state = new URL(login.headers.location as string).searchParams.get('state')!;
            const txCookie = cookiePair(login.headers['set-cookie'], 'tanko_oidc_tx')!;
            const cb = await app2.inject({
                method: 'GET',
                url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
                headers: { cookie: txCookie }
            });
            expect(cb.headers.location).toBe('/?auth_error=failed');
        } finally {
            await app2.close();
        }
    });

    it('enforces allowedGroups from ID token or userinfo', async () => {
        const denyFetch = createMockFetch(() => ({ name: 'Bob', groups: ['other'] }));
        const { app: denyApp } = await buildApp({ allowedGroups: ['tanko'] }, denyFetch);
        try {
            const login = await denyApp.inject({ method: 'GET', url: '/auth/login', headers: { host: 'tanko.local' } });
            const redirectUrl = new URL(login.headers.location as string);
            const state = redirectUrl.searchParams.get('state')!;
            const nonce = redirectUrl.searchParams.get('nonce')!;
            const challenge = redirectUrl.searchParams.get('code_challenge')!;
            const txCookie = cookiePair(login.headers['set-cookie'], 'tanko_oidc_tx')!;
            const cb = await denyApp.inject({
                method: 'GET',
                url: `/auth/callback?code=${encodeURIComponent(`${nonce}:${challenge}`)}&state=${encodeURIComponent(state)}`,
                headers: { cookie: txCookie }
            });
            expect(cb.headers.location).toBe('/?auth_error=forbidden');
            expect(cookiePair(cb.headers['set-cookie'], SESSION_COOKIE)).toBeUndefined();
        } finally {
            await denyApp.close();
        }

        const allowFetch = createMockFetch(() => ({ name: 'Bob' }), { sub: 'user-123', groups: ['tanko'] });
        const { app: allowApp } = await buildApp({ allowedGroups: ['tanko'] }, allowFetch);
        try {
            const login = await allowApp.inject({ method: 'GET', url: '/auth/login', headers: { host: 'tanko.local' } });
            const redirectUrl = new URL(login.headers.location as string);
            const state = redirectUrl.searchParams.get('state')!;
            const nonce = redirectUrl.searchParams.get('nonce')!;
            const challenge = redirectUrl.searchParams.get('code_challenge')!;
            const txCookie = cookiePair(login.headers['set-cookie'], 'tanko_oidc_tx')!;
            const cb = await allowApp.inject({
                method: 'GET',
                url: `/auth/callback?code=${encodeURIComponent(`${nonce}:${challenge}`)}&state=${encodeURIComponent(state)}`,
                headers: { cookie: txCookie }
            });
            expect(cb.headers.location).toBe('/');
            expect(cookiePair(cb.headers['set-cookie'], SESSION_COOKIE)).toBeDefined();
        } finally {
            await allowApp.close();
        }
    });
});
