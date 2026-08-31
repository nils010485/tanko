/**
 * Curated native connectors registered by default (before the legacy adapters).
 */
import type { SourceAdapter } from '../types.js';
import { AsuraScansConnector } from './asurascans.js';
import { MadaraConnector } from './madara.js';
import { MangaDexConnector } from './mangadex.js';
import { VComicsConnector } from './vcomics.js';

export function createNativeConnectors(): SourceAdapter[] {
    return [
        new MangaDexConnector(),
        new AsuraScansConnector(),
        new VComicsConnector({
            id: 'hivetoons',
            label: 'HiveToons',
            base: 'https://hivetoons.org',
            tags: ['webtoon', 'english', 'manhwa']
        }),
        new MadaraConnector({
            id: 'toonily',
            label: 'Toonily',
            base: 'https://toonily.com',
            tags: ['webtoon', 'english', 'manhwa']
        }),
        new MadaraConnector({
            id: 'mangadistrict',
            label: 'Manga District',
            base: 'https://mangadistrict.com',
            tags: ['manga', 'english', 'manhua']
        }),
        // search page fallback covers NoAjax Madara sites (ToonGod, KunManga)
        new MadaraConnector({
            id: 'toongod',
            label: 'ToonGod',
            base: 'https://toongod.org',
            tags: ['webtoon', 'english', 'manhwa']
        }),
        new MadaraConnector({
            id: 'kunmanga',
            label: 'KunManga',
            base: 'https://www.kunmanga.online',
            chapterApiPath: '/api/comics',
            tags: ['webtoon', 'english']
        }),
        // theme decodes chapter pages client-side (blob:) -> capture mode
        new MadaraConnector({
            id: 'raijinscans',
            label: 'Raijin Scans',
            base: 'https://raijin-scans.fr',
            capturePages: true,
            tags: ['manga', 'french', 'webtoon']
        }),
        // Aqua theme renamed the Madara classes (aqua-*)
        new MadaraConnector({
            id: 'aquareader',
            label: 'Aqua Manga',
            base: 'https://aquareader.org',
            tags: ['manga', 'english', 'manhua'],
            selectors: { chapters: '.aqua-ch-item', chapterAnchor: '' }
        })
    ];
}
