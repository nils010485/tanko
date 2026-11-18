/**
 * Server configuration: environment variables with sane defaults,
 * persisted state lives under DATA_DIR.
 */
import path from 'node:path';

export interface OidcConfig {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    publicUrl?: string;
    scopes: string;
    allowedGroups: string[];
    sessionTtlSeconds: number;
    sessionSecret?: string;
}

export interface ServerConfig {
    host: string;
    port: number;
    dataDirectory: string;
    dashboardDirectory: string;
    /** When set, an import job (scan+match+sync) runs automatically at startup. */
    importPath?: string;
    /** 'auto' (default) | 'all' | 'none' - which match tiers are confirmed without user review. */
    importAutoConfirm: 'auto' | 'all' | 'none';
    /** IMPORT_AUTO_DOWNLOAD=1: imported entries auto-download future new chapters. */
    importAutoDownload: boolean;
    oidc?: OidcConfig;
}

function loadOidcConfig(): OidcConfig | undefined {
    const issuer = process.env.OIDC_ISSUER?.trim().replace(/\/+$/, '');
    const clientId = process.env.OIDC_CLIENT_ID?.trim();
    if (!issuer || !clientId) {
        return undefined;
    }
    const allowedGroups = (process.env.OIDC_ALLOWED_GROUPS || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    const defaultScopes = allowedGroups.length > 0 ? 'openid profile email groups' : 'openid profile email';
    const rawTtlHours = Number(process.env.OIDC_SESSION_TTL_HOURS || 168);
    const ttlHours = Number.isFinite(rawTtlHours) && rawTtlHours > 0 ? rawTtlHours : 168;
    return {
        issuer,
        clientId,
        clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || undefined,
        publicUrl: process.env.OIDC_PUBLIC_URL?.trim().replace(/\/+$/, '') || undefined,
        scopes: process.env.OIDC_SCOPES?.trim() || defaultScopes,
        allowedGroups,
        sessionTtlSeconds: Math.max(300, Math.round(ttlHours * 3600)),
        sessionSecret: process.env.OIDC_SESSION_SECRET?.trim() || undefined
    };
}

export function loadConfig(): ServerConfig {
    const dataDirectory = path.resolve(process.env.DATA_DIR || process.env.HAKUNEKO_DATA || './data');
    const autoConfirm = process.env.IMPORT_AUTO_CONFIRM || 'auto';
    return {
        host: process.env.HOST || '0.0.0.0',
        port: Number(process.env.PORT || 8080),
        dataDirectory,
        dashboardDirectory: path.resolve(import.meta.dirname, '../../dashboard/dist'),
        importPath: process.env.IMPORT_PATH || undefined,
        importAutoConfirm: autoConfirm === 'all' || autoConfirm === 'none' ? autoConfirm : 'auto',
        importAutoDownload: process.env.IMPORT_AUTO_DOWNLOAD === '1',
        oidc: loadOidcConfig()
    };
}
