/**
 * Native MagaPoke (Shonen Magazine Pocket, Kodansha) connector.
 *
 * The site is a Nuxt 3 SPA rebuilt from scratch (the old CoreView template
 * selectors are gone). Chain: /series (SSR, 637 titles) -> episodes via the
 * RSS CDN feed mgpk-cdn.../static/rss/<titleId>/feed.xml -> page list via the
 * signed viewer API se-api.pocket.shonenmagazine.com/web/episode/viewer with
 * the x-manga-hash header.
 *
 * x-manga-hash recipe (extracted from the Nuxt bundle, secret = empty string):
 *   Zf(k, v)        = SHA256(k) + '_' + SHA512(v)
 *   join            = [Zf(k, v) for sorted params].toString()
 *   x-manga-hash    = SHA512(SHA256(join) + Zf('', ''))
 *
 * LIMITATION (scramble): page JPGs are puzzle-scrambled; the API returns a
 * scramble_seed and the official reader reassembles them with a WASM/canvas
 * descrambler. This connector does NOT descramble: pages are returned as-is
 * (tiles visually shuffled).
 *
 * LIMITATION (signed URLs): page_list URLs are CloudFront-signed and expire
 * after ~30 min — always call getPages() again before downloading. Images
 * answer 200 without Referer, so no fetchPageImage is needed.
 * Premium episodes fail cleanly (response_code 3105 "episode unpurchased").
 */

import { createHash } from 'node:crypto';
import { browserEnabled, getPageHTML } from '../../shims/browser.js';
import { parseDocument } from '../../shims/dom.js';
import { randomUserAgent } from '../../shims/request.js';
import type { ChapterInfo, HealthResult, MangaInfo, PageList, SourceAdapter } from '../types.js';
import { errorMessage, SourceError } from '../types.js';

const SITE = 'https://pocket.shonenmagazine.com';
const RSS_CDN = 'https://mgpk-cdn.magazinepocket.com';
const VIEWER_API = 'https://se-api.pocket.shonenmagazine.com';

function sha(algorithm: string, value: string): string {
    return createHash(algorithm).update(value).digest('hex');
}

function signedPair(key: string, value: string): string {
    return `${sha('sha256', key)}_${sha('sha512', value)}`;
}

/** Reproduction of the bundle's hash (secret: empty string). */
function mangaHash(params: Record<string, string>): string {
    const joined = Object.keys(params)
        .sort()
        .map(key => signedPair(key, params[key]))
        .toString();
    return sha('sha512', sha('sha256', joined) + signedPair('', ''));
}

interface ViewerResponse {
    response_code?: number;
    error_message?: string;
    scramble_seed?: string;
    page_list?: string[];
}

export class MagaPokeConnector implements SourceAdapter {
    readonly kind = 'native' as const;
    readonly id = 'shonenmagazine-pocket';
    readonly label = 'MagaPoke (Shonen Magazine Pocket)';
    readonly tags = ['manga', 'japanese'];
    readonly url = SITE;

    async initialize(): Promise<void> {}

    private async _getText(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: { 'user-agent': randomUserAgent(), accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'ja,en,*;q=0.5' },
            redirect: 'follow'
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} on ${new URL(url).hostname}`, this.id);
        }
        return response.text();
    }

    async searchMangas(query: string): Promise<MangaInfo[]> {
        let html = await this._getText(`${SITE}/series`);
        // the series grid is hydrated by Nuxt: the static shell carries no items
        if (!html.includes('c-series-item__ttl') && browserEnabled()) {
            const rendered = await getPageHTML(`${SITE}/series`, { timeoutMs: 60_000 }).catch(() => undefined);
            if (rendered?.html) {
                html = rendered.html;
            }
        }
        const document = parseDocument(html);
        const needle = query.trim().toLowerCase();
        const results: MangaInfo[] = [];
        const seen = new Set<string>();
        for (const anchor of [...document.querySelectorAll('li.c-series-items__item a.c-series-item')]) {
            const href = anchor.getAttribute('href') || '';
            if (!href.includes('/title/') || seen.has(href)) {
                continue;
            }
            seen.add(href);
            const title =
                anchor.querySelector('h3.c-series-item__ttl')?.textContent?.replace(/\s+/g, ' ').trim() ||
                anchor.querySelector('img')?.getAttribute('alt')?.trim() ||
                '';
            if (!title || (needle && !title.toLowerCase().includes(needle))) {
                continue;
            }
            results.push({
                id: `${SITE}${href}`,
                title,
                url: `${SITE}${href}`,
                thumbnail: anchor.querySelector('img')?.getAttribute('src') || undefined
            });
        }
        return results;
    }

    async getChapters(manga: MangaInfo): Promise<ChapterInfo[]> {
        const titleId = (manga.url || manga.id).match(/\/title\/(\d+)/)?.[1];
        if (!titleId) {
            throw new SourceError(`Impossible d'identifier le titre depuis ${manga.url || manga.id}`, this.id);
        }
        const numericId = String(Number(titleId));
        const xml = await this._getText(`${RSS_CDN}/static/rss/${numericId}/feed.xml`);
        const document = parseDocument(xml);
        const chapters: ChapterInfo[] = [];
        for (const item of [...document.querySelectorAll('item')]) {
            const link = item.querySelector('link')?.textContent?.trim() || '';
            const episodeId = link.match(/\/episode\/(\d+)/)?.[1];
            if (!episodeId) {
                continue;
            }
            const title = item.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() || `Episode ${episodeId}`;
            const url = `${SITE}/title/${titleId}/episode/${episodeId}`;
            chapters.push({ id: episodeId, title, url });
        }
        if (chapters.length === 0) {
            throw new SourceError(`Aucun épisode RSS trouvé pour "${manga.title}" sur ${this.label}`, this.id);
        }
        // feed lists newest first -> chronological
        return chapters.reverse();
    }

    async getPages(_manga: MangaInfo, chapter: ChapterInfo): Promise<PageList> {
        const episodeId = (chapter.id.match(/\d+/) || [])[0] || chapter.id;
        const url = `${VIEWER_API}/web/episode/viewer?episode_id=${episodeId}`;
        const response = await fetch(url, {
            headers: {
                'user-agent': randomUserAgent(),
                accept: 'application/json',
                'x-manga-hash': mangaHash({ episode_id: episodeId }),
                'x-manga-platform': '3'
            }
        });
        if (!response.ok) {
            throw new SourceError(`HTTP ${response.status} sur le viewer API ${this.label}`, this.id);
        }
        let payload: ViewerResponse;
        try {
            payload = (await response.json()) as ViewerResponse;
        } catch (error) {
            throw new SourceError(`Réponse JSON invalide sur ${this.label}: ${errorMessage(error)}`, this.id);
        }
        if (payload.response_code !== 0) {
            const detail = payload.error_message ? ` (${payload.error_message})` : '';
            throw new SourceError(`Épisode indisponible pour "${chapter.title}" sur ${this.label}${detail}`, this.id);
        }
        const pages = (payload.page_list || []).filter(url => !!url);
        if (pages.length === 0) {
            throw new SourceError(`No pages found for "${chapter.title}" on ${this.label}`, this.id);
        }
        return pages;
    }

    async checkHealth(): Promise<HealthResult> {
        const startedAt = Date.now();
        try {
            const html = await this._getText(`${SITE}/series`);
            if (!html.includes('c-series-items__item')) {
                return { ok: false, latencyMs: Date.now() - startedAt, error: 'Liste de séries vide (site modifié ?)' };
            }
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return { ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
        }
    }
}
