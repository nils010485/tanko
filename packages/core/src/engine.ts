/**
 * Bootstrap the headless Hakuneko engine:
 * install globals, wire up the Engine global and load legacy connectors.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LegacyConnector } from './legacy-types.js';
import { currentAbortSignal } from './shims/abort-scope.js';
import { browserEnabled, getPageHTML } from './shims/browser.js';
import { ConnectorPool } from './shims/connector-pool.js';
import { installGlobals } from './shims/globals.js';
import { HeadlessRequest } from './shims/request.js';
import { HeadlessSettings } from './shims/settings.js';
import { HeadlessStorage } from './shims/storage.js';
import { loadOverrides } from './sources/native/config.js';

export interface EngineContext {
    Settings: HeadlessSettings;
    Storage: HeadlessStorage;
    Request: HeadlessRequest;
    Blacklist: { patterns: string[] };
    ComicInfoGenerator: { createComicInfoXML: () => string };
}

export interface LoadResult {
    connectors: LegacyConnector[];
    failures: number;
}

/** Directory containing the vendored legacy engine (src/web/mjs of hakuneko). */
export const VENDOR_PATH = path.resolve(import.meta.dirname, '../vendor');

/**
 * Connectors we patch on top of the upstream Hakuneko tree. Sites change
 * under upstream's feet and its connectors break (e.g. mangahere removed
 * the newImgs global from its webtoon reader); our bundled version carries
 * the fix. These files are ALWAYS loaded from the bundled vendor - even
 * when a previously synced copy shadows it - and the sources updater
 * re-applies them over every new sync. Drop an entry once upstream ships
 * the same fix.
 */
export const CONNECTOR_OVERRIDES = ['MangaFox.mjs', 'ComicMeteor.mjs', 'ComicPolaris.mjs', 'LELScan.mjs', 'ToomicsKO.mjs'];

const connectorRegistry = new Map<string, LegacyConnector>();
/** Connector id -> source file: a worker re-imports the very file the host loaded. */
const connectorFilePaths = new Map<string, string>();
let connectorPool: ConnectorPool | undefined;
let fetchWrapped = false;
/**
 * The global fetch wrapper is installed once but must delegate to the
 * CURRENT engine's session (cookie jar, gate) - a second createEngine with
 * another dataDirectory would otherwise silently keep the first jar.
 */
let activeRequest: HeadlessRequest | undefined;
/** Active vendor directory: synced copy in the data directory if present, else the built-in one. */
let activeVendorPath = VENDOR_PATH;

/** Failure count of the first load, reported by repeat calls. */
let lastFailures: number | undefined;
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

export function getConnectorFilePath(id: string): string | undefined {
    return connectorFilePaths.get(id);
}

/** Off-main-thread connector pool of the active engine (undefined before createEngine). */
export function getConnectorPool(): ConnectorPool | undefined {
    return connectorPool;
}

/** Escape hatch for tests that stub the in-process engine: run every connector call on this thread. */
export function inProcessConnectors(): boolean {
    return process.env.TANKO_CONNECTOR_INPROCESS === '1';
}

export async function createEngine(options: { dataDirectory: string }): Promise<EngineContext> {
    installGlobals();

    const dataDirectory = path.resolve(options.dataDirectory);
    loadOverrides(path.join(dataDirectory, 'sources-overrides.json'));
    // Prefer a synced copy of the connectors (written by the updater) over the
    // built-in vendored one; falls back when no sync has happened yet.
    const syncedVendor = path.join(dataDirectory, 'vendor');
    const syncedConnectors = path.join(syncedVendor, 'connectors');
    activeVendorPath = directoryHasConnectors(syncedConnectors) ? syncedVendor : VENDOR_PATH;
    // Self-heal an already-synced tree: re-apply the patched connectors over
    // it (the updater does the same after each sync) - otherwise an old synced
    // copy shadows bundled fixes, including for subclasses that import their
    // base connector with a relative path.
    if (activeVendorPath !== VENDOR_PATH) {
        for (const file of CONNECTOR_OVERRIDES) {
            fs.copyFileSync(path.join(VENDOR_PATH, 'connectors', file), path.join(syncedConnectors, file));
        }
    }
    const settings = new HeadlessSettings(dataDirectory);
    const storage = new HeadlessStorage(settings);
    const request = new HeadlessRequest();
    activeRequest = request;

    // Legacy list operations parse HTML synchronously (seconds on a big
    // catalog): they run in worker processes, fed by this session. A second
    // engine reuses the process, so the previous pool's workers must go.
    void connectorPool?.dispose().catch(() => undefined);
    connectorPool = new ConnectorPool({
        request,
        renderPage: (url, options) =>
            browserEnabled()
                ? getPageHTML(url, { userAgent: request.userAgent, timeoutMs: options.timeoutMs })
                : Promise.reject(new Error('no browser backend'))
    });

    // Intercept the legacy 'connector://' protocol used for protected media
    // (e.g. MangaDex@Home) and route it to the owning connector.
    if (!fetchWrapped) {
        fetchWrapped = true;
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = requestUrl(input);
            if (url?.startsWith('connector://')) {
                const uri = new URL(url);
                const connectorFile = inProcessConnectors() ? undefined : getConnectorFilePath(uri.hostname);
                if (connectorPool && connectorFile) {
                    const result = await connectorPool.run<{ data: ArrayBuffer; mimeType: string }>(
                        uri.hostname,
                        connectorFile,
                        'handleConnectorURI',
                        [uri.href],
                        currentAbortSignal()
                    );
                    return new Response(new Blob([result.data], { type: result.mimeType }), { status: 200 });
                }
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
            // transformation happens headless - otherwise CDNs receive literal x-*
            // headers and serve hotlink-protection HTML instead of the image.
            if (input instanceof Request && [...input.headers.keys()].some(name => name.toLowerCase().startsWith('x-'))) {
                const bridge = activeRequest as HeadlessRequest;
                // the legacy bridge cannot take a signal: race it so an aborted
                // crawl stops waiting (the bridge's own deadline reclaims the
                // socket) - mirrors the signal merge of the native branch below
                const scope = currentAbortSignal();
                const own = init?.signal ?? input.signal;
                const signal = scope && own ? AbortSignal.any([scope, own]) : (scope ?? own);
                if (!signal) {
                    return bridge.fetch(input);
                }
                const aborted = new Promise<never>((_, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
                });
                return Promise.race([bridge.fetch(input), aborted]);
            }
            // Kill the whole crawl when the owning operation is aborted (see
            // shims/abort-scope.ts): the scope signal rides along every fetch.
            // init.signal (or the Request's own) still applies - combine them.
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
        ComicInfoGenerator: {
            createComicInfoXML: () => '' // ComicInfo.xml is generated inside HeadlessStorage
        }
    };
    globalThis.Engine = engine;
    return engine;
}

/**
 * Synced copies ship a sha256 manifest (written by the updater at sync time);
 * the built-in vendor has none - integrity checking is skipped there. A file
 * failing its hash (truncated write, tampered data directory) is never imported.
 */
function readManifest(directory: string): Record<string, string> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, '.manifest.json'), 'utf8')) as { files?: Record<string, string> };
        return parsed.files ?? null;
    } catch {
        return null;
    }
}

function manifestMatches(manifest: Record<string, string>, directory: string, file: string): boolean {
    const expected = manifest[file];
    if (!expected) {
        return false;
    }
    const actual = createHash('sha256')
        .update(fs.readFileSync(path.join(directory, file)))
        .digest('hex');
    return actual === expected;
}

/**
 * Load all legacy connectors (top-level .mjs files, excluding templates/system).
 * Failed imports are counted and skipped.
 */
export async function loadConnectors(): Promise<LoadResult> {
    if (lastFailures !== undefined) {
        return { connectors: [...connectorRegistry.values()].sort(byLabel), failures: lastFailures };
    }

    const directory = path.join(getVendorDirectory(), 'connectors');
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.mjs') && !file.startsWith('.'));
    const manifest = readManifest(directory);

    const connectors: LegacyConnector[] = [];
    let failures = 0;
    for (const file of files) {
        try {
            if (manifest && !manifestMatches(manifest, directory, file)) {
                failures++;
                console.warn(`[engine] connector "${file}" failed the integrity check - skipped (resync to fix)`);
                continue;
            }
            const module = await import(pathToFileURL(path.join(directory, file)).href);
            const connector = new module.default() as LegacyConnector;
            if (!connectorRegistry.has(connector.id)) {
                connectorRegistry.set(connector.id, connector);
                connectorFilePaths.set(String(connector.id), path.join(directory, file));
                connectors.push(connector);
            }
        } catch (error) {
            failures++;
            console.warn(`[engine] connector "${file}" failed to load:`, error);
        }
    }
    connectors.sort(byLabel);
    lastFailures = failures;
    return { connectors, failures };
}

/** Case-insensitive connector label ordering. */
function byLabel(a: { label: string }, b: { label: string }): number {
    return a.label.toLowerCase() < b.label.toLowerCase() ? -1 : 1;
}
