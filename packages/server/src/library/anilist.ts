/**
 * AniList (graphql.anilist.co) title lookup: free GraphQL API, no key. For a
 * manga/manhwa it knows the official titles (english, romaji, native) plus the
 * alternative spellings, which feed the failover's search aliases — series are
 * often hosted on other sources under another name.
 */
import { REVIEW_THRESHOLD, titleSimilarity } from '../import/similarity.js';

const ENDPOINT = 'https://graphql.anilist.co';
const TIMEOUT_MS = 10_000;
/** Search hits inspected: the best-scoring entry is kept. */
const CANDIDATES = 3;

const QUERY = `query ($search: String) {
    Page(perPage: ${CANDIDATES}) {
        media(search: $search, type: MANGA) {
            title { romaji english native }
            synonyms
        }
    }
}`;

interface AniListMedia {
    title: { romaji: string | null; english: string | null; native: string | null };
    synonyms: Array<string | null>;
}

/** Every title AniList knows for a media entry, deduplicated, most relevant
 *  first (english first: it is what sources usually index). */
function knownTitles(media: AniListMedia): string[] {
    const names = [media.title.english, media.title.romaji, media.title.native, ...media.synonyms];
    return [...new Set(names.filter((name): name is string => !!name?.trim()))];
}

/**
 * Alternative titles of `title` from AniList: searches the API, keeps the hit
 * whose titles match `title` best, returns all its names. Empty when AniList
 * has no convincing match (its search fell back to something unrelated);
 * throws on network/HTTP failure so the caller can surface the error.
 */
export async function fetchTitleAliases(title: string): Promise<string[]> {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { search: title } }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`AniList HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { data?: { Page?: { media?: Array<AniListMedia | null> } } };
    const media = (payload.data?.Page?.media ?? []).filter((entry): entry is AniListMedia => !!entry);
    let best: { titles: string[]; score: number } | null = null;
    for (const entry of media) {
        const titles = knownTitles(entry);
        const score = Math.max(0, ...titles.map(name => titleSimilarity(title, name)));
        if (!best || score > best.score) {
            best = { titles, score };
        }
    }
    return best && best.score >= REVIEW_THRESHOLD ? best.titles : [];
}
