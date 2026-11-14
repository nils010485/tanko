/**
 * The legacy connector search algorithm, shared by the in-process adapter and
 * the connector worker so both paths answer identically: a site search
 * endpoint when the connector has one (single request), otherwise the whole
 * catalog filtered by title (minutes on some sites). Returns raw records;
 * each side maps them to its own shape.
 */
import type { LegacyConnector, LegacyManga } from '../legacy-types.js';

export async function searchLegacyMangas(
    connector: LegacyConnector,
    query: string,
    getMangaList: () => Promise<LegacyManga[] | undefined>
): Promise<LegacyManga[]> {
    if (typeof connector._searchMangas === 'function') {
        return (await connector._searchMangas(query)) || [];
    }
    const needle = query.trim().toLowerCase();
    const mangas = await getMangaList();
    return (mangas || []).filter(manga => manga.title?.toLowerCase().includes(needle));
}
