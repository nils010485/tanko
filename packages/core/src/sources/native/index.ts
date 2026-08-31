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
        })
    ];
}
