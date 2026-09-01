/**
 * Shared HTTP helpers for native connectors: URL resolution against a base and
 * the plain-fetch -> headless-Chromium fallback every anti-bot-shelled site
 * needs. Keeps the per-connector classes down to their actual scraping logic.
 */

import { browserEnabled, getPageHTML, isAntiBotShell } from '../../shims/browser.js';
import { randomUserAgent } from '../../shims/request.js';
import { SourceError } from '../types.js';

/** Resolve href against base, null when href is empty or unparseable. */
export function absoluteUrl(href: string | undefined | null, base: string): string | null {
    if (!href) {
        return null;
    }
    try {
        return new URL(href, base).href;
    } catch {
        return null;
    }
}

export interface NativeTextOptions {
    /** connector id (error attribution) */
    id: string;
    headers?: Record<string, string>;
    /** extra RequestInit (method/body/signal) merged over the defaults */
    init?: RequestInit;
    /** accept the plain response only when the body is at least this long
     *  (client-rendered shells are small; SSR pages are not) */
    minBytes?: number;
    /** browser render timeout (default 30s) */
    timeoutMs?: number;
    /** extra validation of the plain response (e.g. zeurelscan's fake 400s) */
    accept?: (response: Response, body: string) => boolean;
    /** error used when neither plain fetch nor the browser produced HTML */
    renderError?: string;
}

/** Fetch page text over plain HTTP, escalating to the anti-bot browser when
 *  the response is an error, too small, or a challenge shell. */
export async function fetchNativeText(url: string, options: NativeTextOptions): Promise<string> {
    let response: Response | undefined;
    try {
        response = await fetch(url, {
            headers: {
                'user-agent': randomUserAgent(),
                accept: 'text/html,application/xhtml+xml',
                'accept-language': 'en,*;q=0.5',
                ...options.headers
            },
            redirect: 'follow',
            ...options.init
        });
    } catch {
        /* network error -> browser fallback below */
    }
    const body = response ? await response.text().catch(() => '') : '';
    const accepted =
        !!response &&
        (options.accept ? options.accept(response, body) : response.ok) &&
        !isAntiBotShell(body, response.status) &&
        body.length >= (options.minBytes ?? 0);
    if (accepted) {
        return body;
    }
    if (browserEnabled()) {
        const rendered = await getPageHTML(url, { timeoutMs: options.timeoutMs ?? 30_000 }).catch(() => undefined);
        if (rendered?.html && !isAntiBotShell(rendered.html)) {
            return rendered.html;
        }
    }
    if (response && !response.ok) {
        throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, options.id);
    }
    throw new SourceError(options.renderError ?? `Page protégée par anti-bot (JavaScript requis) sur ${new URL(url).hostname}`, options.id);
}
