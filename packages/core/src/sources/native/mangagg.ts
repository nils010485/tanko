/**
 * Native MangaGG (mangagg.com) connector — Madara (WordPress) variant:
 * comics live under /comic/<slug>/, the theme search only indexes blog posts,
 * so comic search uses the native WP query with the theme's hidden
 * post_type=wp-manga (the exact value the site's own header form injects).
 *
 * Chain: GET /?s=<q>&post_type=wp-manga (results: .c-tabs-item__content) ->
 * manga page (only "Read first/last" buttons, no static chapter list) ->
 * POST <manga>/ajax/chapters/ (X-Requested-With + Origin/Referer required,
 * plain POST without them answers 400) -> chapter page (div.page-break img).
 *
 * Cloudflare: HTML pages and image hosts (s2/s4.mangagg.com) challenge
 * non-browser TLS fingerprints (undici gets 403 challenge, curl passes) ->
 * every request falls back to the solved browser session, and images go
 * through fetchPageImage().
 *
 * LIMITATION (chapter list): the ajax endpoint only returns the ~24 most
 * recent chapters — that is all the site itself exposes in its reader UI
 * (older chapters stay reachable by URL but are not listed anywhere).
 */

import { browserEnabled, isAntiBotShell } from '../../shims/browser.js';
import { browserFetch, browserFetchBinary } from '../../shims/browser-session.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const BASE = 'https://mangagg.com';

export class MangaGGConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'mangagg';
    readonly label = 'MangaGG';
    readonly tags = ['manga', 'manhwa', 'manhua', 'english'];
    readonly url = BASE;

    async initialize(): Promise<void> {}

    private async _browserText(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<string> {
        const response = await browserFetch(BASE, url, init).catch((error: unknown) => {
            throw new SourceError(errorMessage(error), this.id, error);
        });
        if (!response.ok || isAntiBotShell(response.body, response.status)) {
            throw new SourceError(`${init.method || 'GET'} ${url} inaccessible même via navigateur (HTTP ${response.status})`, this.id);
        }
        return response.body;
    }

    /** Plain fetch first; Cloudflare challenges undici -> browser session. */
    private async _getText(url: string): Promise<string> {
        let body = '';
        let ok = false;
        try {
            const response = await fetch(url, {
                headers: { 'user-agent': randomUserAgent(), accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'en,*;q=0.5' },
                redirect: 'follow'
            });
            body = await response.text().catch(() => '');
            ok = response.ok && !isAntiBotShell(body, response.status);
        } catch {
            /* network error -> browser fallback below */
        }
        if (!ok && browserEnabled()) {
            return this._browserText(url);
        }
        if (!ok) {
            throw new SourceError(`Page inaccessible sur ${new URL(url).hostname} (anti-bot, Chromium requis)`, this.id);
        }
        return body;
    }

    private async _postChapters(mangaUrl: string): Promise<string> {
        const url = `${mangaUrl}/ajax/chapters/`;
        const init = {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'x-requested-with': 'XMLHttpRequest',
                origin: BASE,
                referer: `${mangaUrl}/`
            },
            body: ''
        };
        try {
            const response = await fetch(url, {
                ...init,
                headers: { 'user-agent': randomUserAgent(), accept: '*/*', ...init.headers }
            });
            if (response.ok) {
                const body = await response.text();
                if (body.includes('wp-manga-chapter')) {
                    return body;
                }
            }
        } catch {
            /* fall through to the browser session */
        }
        if (browserEnabled()) {
            return this._browserText(url, init);
        }
        throw new SourceError(`Liste de chapitres inaccessible sur ${this.label} (anti-bot, Chromium requis)`, this.id);
    }

    private _parseResults(html: string): MangaInfo[] {
        const document = parseDocument(html);
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [
            ...document.querySelectorAll('#loop-content .c-tabs-item__content .post-title a, #loop-content .page-item-detail .post-title a')
        ]) {
            const href = anchor.getAttribute('href') || '';
            if (!href.includes('/comic/') || seen.has(href)) {
                continue;
            }
            seen.add(href);
            const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!title) {
                continue;
            }
            const thumbnail = anchor.closest('.c-tabs-item__content, .page-item-detail')?.querySelector('img')?.getAttribute('src') || undefined;
            results.push({ id: href, title, url: href, thumbnail });
        }
        return results;
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        const results = this._parseResults(await this._getText(`${BASE}/?s=${encodeURIComponent(query.trim())}&post_type=wp-manga`));
        if (results.length > 0 || query.trim()) {
            return results;
        }
        // empty query: list the /comic/ archive grid instead
        return this._parseResults(await this._getText(`${BASE}/comic/`));
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const mangaUrl = (manga.url || manga.id).replace(/\/$/, '');
        const html = await this._postChapters(mangaUrl);
        const document = parseDocument(html);
        const chapters: ChapterInfo[] = [];
        for (const anchor of [...document.querySelectorAll('li.wp-manga-chapter a')]) {
            const href = anchor.getAttribute('href') || '';
            const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
            if (!href || !title) {
                continue;
            }
            chapters.push({ id: href, title, url: href });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun chapitre trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const html = await this._getText(chapter.url || chapter.id);
        const document = parseDocument(html);
        const images = [...document.querySelectorAll('div.page-break img, div.reading-content img')]
            .map(img => img.getAttribute('src')?.trim())
            .filter((src): src is string => !!src && !src.startsWith('data:'))
            .map(src => {
                try {
                    return new URL(src, BASE).href;
                } catch {
                    return null;
                }
            })
            .filter((src): src is string => !!src);
        if (images.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return images;
    }

    /** Image hosts (s2/s4.mangagg.com) sit behind the same Cloudflare wall. */
    async fetchPageImage(url: string): Promise<{ mime: string; data: Uint8Array }> {
        const response = await fetch(url, { headers: { 'user-agent': randomUserAgent(), referer: `${BASE}/`, accept: 'image/*,*/*' } }).catch(() => undefined);
        if (response?.ok) {
            return {
                mime: response.headers.get('content-type')?.split(';')[0] || 'image/jpeg',
                data: new Uint8Array(await response.arrayBuffer())
            };
        }
        if (browserEnabled()) {
            const binary = await browserFetchBinary(new URL(url).origin, url).catch(() => undefined);
            if (binary?.status === 200) {
                return { mime: binary.mime, data: binary.data };
            }
        }
        throw new SourceError(`HTTP ${response?.status || '???'} on ${new URL(url).hostname}`, this.id);
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const html = await this._getText(`${BASE}/comic/`);
            if (!html.includes('page-item-detail')) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Catalogue vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
