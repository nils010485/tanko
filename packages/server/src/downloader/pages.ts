/**
 * Page fetching for the download queue: page-list retrieval with retries,
 * per-page download (connector routing, legacy engine bridge, plain HTTP)
 * with backoff, and URL decoration for error messages.
 */
import type { SourceAdapter } from '@tanko/core';
import { LegacySourceAdapter, randomUserAgent } from '@tanko/core';
import { withTimeout } from '../util/timeout.js';
import { detectMime } from './paths.js';
import type { DomainGate } from './rate-limiter.js';

/** Identifiers of a job row as the page helpers see it. */
export interface PageJobRef {
    id: number;
    manga_id: string;
    manga_title: string;
    chapter_id: string;
    chapter_title: string;
}

const USER_AGENT = randomUserAgent();
const PAGE_ATTEMPTS = 3;
/** Max page-list refreshes per chapter: pages fetched through signed URLs
 *  (connector:// payloads with ?expires=…) can go stale mid-chapter. */
export const PAGE_LIST_REFRESHES = 2;

/** Shape of the legacy engine bridge installed on globalThis by core's createEngine(). */
interface EngineGlobal {
    Request: { fetch(request: Request): Promise<Response> };
}

/** Human-readable page URL for error messages: 'connector://' payloads are
 *  opaque base64 blobs that bury the real (signed) image URL and wreck the
 *  dashboard layout — decode them and strip the query string instead. */
export function describePageUrl(url: string): string {
    if (url.startsWith('connector://')) {
        try {
            const decoded = Buffer.from(new URL(url).searchParams.get('payload') ?? '', 'base64').toString('utf8');
            // createConnectorURI base64-encodes JSON.stringify(payload): most
            // connectors pass the plain image URL string, a few an object
            // carrying it — decode both shapes.
            const parsed: unknown = JSON.parse(decoded);
            const real = typeof parsed === 'string' ? parsed : (parsed as { url?: unknown } | null)?.url;
            if (typeof real === 'string' && real.startsWith('http')) {
                return real.replace(/[?#].*$/, '');
            }
        } catch {
            /* malformed connector URI: fall through to truncation */
        }
        return `${url.slice(0, 64)}…`;
    }
    return url.length > 160 ? `${url.slice(0, 160)}…` : url;
}

/**
 * Page lists can fail intermittently (protected chapter scripts, rate
 * limiting, transient anti-bot pages) — retry with backoff before
 * failing the whole job.
 */
/** Same budget as the plain-HTTP branch's AbortSignal timeout. */
const PAGE_FETCH_TIMEOUT_MS = 120 * 1000;

export async function getPageListWithRetries(
    source: SourceAdapter,
    row: PageJobRef,
    checkCancel: () => void
): Promise<Awaited<ReturnType<SourceAdapter['getPages']>>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
        // throws Error('cancelled') — must propagate untouched (job status contract)
        checkCancel();
        try {
            const pages = await withTimeout(
                source.getPages({ id: row.manga_id, title: row.manga_title }, { id: row.chapter_id, title: row.chapter_title }),
                90 * 1000,
                `getPages(${row.manga_title} - ${row.chapter_title})`
            );
            if (!pages.length) {
                throw new Error('Page list is empty');
            }
            return pages;
        } catch (error) {
            if ((error as Error)?.message === 'cancelled') {
                throw error;
            }
            lastError = error;
            if (attempt < PAGE_ATTEMPTS - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
            }
        }
    }
    throw new Error(`Failed to get page list: ${String((lastError as Error)?.message || lastError)}`);
}

export async function fetchPageWithRetries(url: string, source: SourceAdapter, gate: DomainGate): Promise<{ mime: string; data: Uint8Array }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
        try {
            await gate.pass(url);
            const page = await fetchPage(url, source);
            // a "successfully" fetched page that is not an image (HTML error
            // page, cloudflare challenge, JSON error) must not end up in the
            // chapter: treat it as a failure so the retry/backoff kicks in
            if (!page.mime.toLowerCase().startsWith('image/')) {
                throw new Error(`non-image page (${page.mime}, ${page.data.length} bytes)`);
            }
            return page;
        } catch (error) {
            lastError = error;
            if (attempt < PAGE_ATTEMPTS - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }
    throw new Error(`Failed to download page "${describePageUrl(url)}": ${String((lastError as Error)?.message || lastError)}`);
}

async function fetchPage(url: string, source: SourceAdapter): Promise<{ mime: string; data: Uint8Array }> {
    let response: Response;
    if (url.startsWith('connector://')) {
        // routed to the owning connector by the global fetch wrapper
        response = await withTimeout(fetch(url), PAGE_FETCH_TIMEOUT_MS, `connector page ${describePageUrl(url)}`);
    } else if (source instanceof LegacySourceAdapter) {
        // apply legacy x-* header transformations + cookie jar via the legacy engine bridge
        const engine = (globalThis as unknown as { Engine: EngineGlobal }).Engine;
        const request = new Request(url, source.connector.requestOptions);
        response = await withTimeout(engine.Request.fetch(request), PAGE_FETCH_TIMEOUT_MS, `legacy page ${describePageUrl(url)}`);
    } else {
        if (source.fetchPageImage) {
            try {
                // source in a solved browser session: its image host may
                // block plain HTTP just like the site itself (undici TLS fingerprint)
                return await source.fetchPageImage(url);
            } catch {
                /* not in browser mode / session expired -> raw fetch below */
            }
        }
        let referer: string;
        if (url.startsWith('http') && source.url) {
            referer = `${source.url}/`;
        } else {
            referer = source.url || url;
        }
        response = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
                Referer: referer
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(120000)
        });
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const mime = detectMime(data, response.headers.get('content-type') || 'image/');
    return { mime, data };
}
