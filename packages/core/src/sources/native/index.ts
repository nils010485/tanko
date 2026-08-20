/**
 * Curated native connectors registered by default (before the legacy adapters).
 */
import type { SourceAdapter } from '../types.js';
import { MadaraConnector } from './madara.js';
import { MangaDexConnector } from './mangadex.js';

export function createNativeConnectors(): SourceAdapter[] {
    return [
        new MangaDexConnector(),
        new MadaraConnector({
            id: 'toonily',
            label: 'Toonily',
            base: 'https://toonily.com',
            tags: ['webtoon', 'english', 'manhwa']
        })
    ];
}
