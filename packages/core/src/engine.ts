/**
 * Bootstrap the headless Hakuneko engine:
 * install globals, wire up the Engine global and load legacy connectors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LegacyConnector } from './legacy-types.js';
import { currentAbortSignal } from './shims/abort-scope.js';
import { installGlobals } from './shims/globals.js';
import { HeadlessRequest } from './shims/request.js';
import { HeadlessSettings } from './shims/settings.js';
import { HeadlessStorage } from './shims/storage.js';

export interface EngineContext {
    Settings: HeadlessSettings;
    Storage: HeadlessStorage;
    Request: HeadlessRequest;
    Blacklist: { patterns: string[] };
    Enums: {
        mediaType: { manga: string; anime: string };
        websiteState: { offline: string; available: string };
    };
    ComicInfoGenerator: { createComicInfoXML: () => string };
}

export interface LoadResult {
    connectors: LegacyConnector[];
    failures: number;
}

/** Directory containing the vendored legacy engine (src/web/mjs of hakuneko). */
export const VENDOR_PATH = path.resolve(import.meta.dirname, '../vendor');

const connectorRegistry = new Map<string, LegacyConnector>();
let fetchWrapped = false;
/** Active vendor directory: synced copy in the data directory if present, else the built-in one. */
let activeVendorPath = VENDOR_PATH;

/** Best-effort URL extraction from any fetch() input shape. */
function requestUrl(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }
    if (input instanceof URL) {
        return input.href;
    }
    return (input as Request).url;
}

function directoryHasConnectors(directory: string): boolean {
    try {
        return fs.readdirSync(directory).some(file => file.endsWith('.mjs'));
    } catch {
        return false;
    }
}

/** Directory legacy connectors are loaded from (resolved by createEngine). */
export function getVendorDirectory(): string {
    return activeVendorPath;
}

export async function createEngine(options: { dataDirectory: string }): Promise<EngineContext> {
    installGlobals();

    const dataDirectory = path.resolve(options.dataDirectory);
    // Prefer a synced copy of the connectors (written by the updater) over the
    // built-in vendored one; falls back when no sync has happened yet.
    const syncedVendor = path.join(dataDirectory, 'vendor');
    activeVendorPath = directoryHasConnectors(path.join(syncedVendor, 'connectors')) ? syncedVendor : VENDOR_PATH;
    const settings = new HeadlessSettings(dataDirectory);
    const storage = new HeadlessStorage(settings);
    const request = new HeadlessRequest();

    // Intercept the legacy 'connector://' protocol used for protected media
    // (e.g. MangaDex@Home) and route it to the owning connector.
    if (!fetchWrapped) {
        fetchWrapped = true;
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url?.startsWith('connector://')) {
                const uri = new URL(url);
                const connector = connectorRegistry.get(uri.hostname);
                if (!connector) {
                    throw new Error(`No connector registered for protocol host "${uri.hostname}"`);
                }
                const buffer = await connector.handleConnectorURI(uri);
                return new Response(new Blob([buffer.data], { type: buffer.mimeType }), { status: 200 });
            }
            // Legacy connectors stash the real destination headers as x-* (x-referer,
            // x-cookie, ...) on the Request object; the Electron main process used to
            // translate them before sending. Route those through HeadlessRequest so the
            // transformation happens headless — otherwise CDNs receive literal x-*
            // headers and serve hotlink-protection HTML instead of the image.
            if (input instanceof Request && [...input.headers.keys()].some(name => name.toLowerCase().startsWith('x-'))) {
                return request.fetch(input);
            }
            // Kill the whole crawl when the owning operation is aborted (see
            // shims/abort-scope.ts): the scope signal rides along every fetch.
            // init.signal (or the Request's own) still applies — combine them.
            const scope = currentAbortSignal();
            const own = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            const signal = scope && own ? AbortSignal.any([scope, own]) : (scope ?? own);
            return nativeFetch(input, signal ? { ...init, signal } : init);
        }) as typeof fetch;
    }

    const engine: EngineContext = {
        Settings: settings,
        Storage: storage,
        Request: request,
        Blacklist: { patterns: [] },
        Enums: {
            mediaType: { manga: 'manga', anime: 'anime' },
            websiteState: { offline: 'offline', available: 'available' }
        },
        ComicInfoGenerator: {
            createComicInfoXML: () => '' // ComicInfo.xml is generated inside HeadlessStorage
        }
    };
    globalThis.Engine = engine;
    return engine;
}

/**
 * Load all legacy connectors (top-level .mjs files, excluding templates/system).
 * Failed imports are counted and skipped.
 */
export async function loadConnectors(): Promise<LoadResult> {
    if (connectorRegistry.size > 0) {
        const connectors = [...connectorRegistry.values()].sort(byLabel);
        return { connectors, failures: 0 };
    }

    const directory = path.join(getVendorDirectory(), 'connectors');
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.mjs') && !file.startsWith('.'));

    const connectors: LegacyConnector[] = [];
    let failures = 0;
    for (const file of files) {
        try {
            const module = await import(pathToFileURL(path.join(directory, file)).href);
            const connector = new module.default() as LegacyConnector;
            if (!connectorRegistry.has(connector.id)) {
                connectorRegistry.set(connector.id, connector);
                connectors.push(connector);
            }
        } catch {
            failures++;
        }
    }
    connectors.sort(byLabel);
    return { connectors, failures };
}

/** Case-insensitive connector label ordering. */
function byLabel(a: { label: string }, b: { label: string }): number {
    return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1;
}

export function getConnector(id: string): LegacyConnector | undefined {
    return connectorRegistry.get(id);
}
