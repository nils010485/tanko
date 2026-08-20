/**
 * Title matching for library import: accent/case-insensitive normalization,
 * scanlation-tag stripping, and bigram Dice similarity (with a token-sorted
 * variant so word order and extra words do not dominate the score).
 */

/** Lowercase, strip diacritics, unify apostrophes/quotes, punctuation -> space. */
export function normalizeTitle(title: string): string {
    return title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks (U+0300–U+036F)
        .toLowerCase()
        .replace(/[’‘`]/g, "'")
        .replace(/["“”«»]/g, ' ')
        .replace(/'s\b/g, 's') // "ranker's" -> "rankers" (' already unified above)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Same, but with [...] and (...) segments removed (scanlation/official tags). */
export function stripTags(title: string): string {
    return title.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
}

/** Bigram Dice coefficient: 1 = identical, 0 = no overlap. */
export function bigramDice(a: string, b: string): number {
    if (a === b) {
        return a.length > 0 ? 1 : 0;
    }
    if (a.length < 2 || b.length < 2) {
        return 0;
    }
    const bigrams = new Map<string, number>();
    for (let i = 0; i < a.length - 1; i++) {
        const bigram = a.slice(i, i + 2);
        bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const bigram = b.slice(i, i + 2);
        const count = bigrams.get(bigram) || 0;
        if (count > 0) {
            overlap++;
            bigrams.set(bigram, count - 1);
        }
    }
    return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * Tags that carry no structural meaning: an (author) or scanlation note may
 * be absent from the catalog title without the match becoming ambiguous.
 * "Remake"/seasons/volumes etc. DO change which manga the folder refers to.
 */
const NEUTRAL_TAG_TOKENS = new Set(['official', 'fr', 'vf', 'en', 'webtoon', 'novel', 'colored', 'colour', 'scantrad', 'raw']);

/** Normalized tokens found inside [...] / (...) segments of a title. */
function tagTokens(title: string): Set<string> {
    const tokens = new Set<string>();
    for (const match of title.matchAll(/\[[^\]]*\]|\([^)]*\)/g)) {
        for (const token of normalizeTitle(match[0]).split(' ')) {
            if (token) {
                tokens.add(token);
            }
        }
    }
    return tokens;
}

/** Tag tokens that must be shared with the other title for a confident match. */
function structuralTags(title: string): Set<string> {
    const tokens = new Set<string>();
    for (const token of tagTokens(title)) {
        if (!NEUTRAL_TAG_TOKENS.has(token) && /^\d+$|^(s\d+|season|part|remake|arc|volume|vol|reboot|sequel)$/.test(token)) {
            tokens.add(token);
        }
    }
    return tokens;
}

function tokenSort(text: string): string {
    return text.split(' ').sort().join(' ');
}

/**
 * Similarity between a (folder) name and a catalog title.
 * Tries full and tag-stripped variants, plus a token-sorted pass so that
 * "Dungeon Reset [Official]" vs "Dungeon Reset" and reordered titles score high.
 * Exact equality on untagged titles (1.0) beats tag-stripped equality (0.95),
 * so "Solo Leveling" outranks "Solo Leveling (Book Version)".
 * When either side carries a structural tag the other lacks ("(Remake)"),
 * the score is capped below the auto-confirm threshold to force a review.
 */
export function titleSimilarity(needleRaw: string, candidateRaw: string): number {
    const needleFull = normalizeTitle(needleRaw);
    const candidateFull = normalizeTitle(candidateRaw);
    if (!needleFull || !candidateFull) {
        return 0;
    }
    const needleStripped = normalizeTitle(stripTags(needleRaw));
    const candidateStripped = normalizeTitle(stripTags(candidateRaw));

    let best = 0;
    const pairs: Array<[string, string, boolean]> = [
        [needleFull, candidateFull, true],
        [needleStripped, candidateStripped, false],
        [needleFull, candidateStripped, false],
        [needleStripped, candidateFull, false]
    ];
    for (const [left, right, untagged] of pairs) {
        if (!left || !right) {
            continue;
        }
        if (left === right) {
            best = Math.max(best, untagged ? 1 : 0.95);
        } else {
            best = Math.max(best, bigramDice(left, right), bigramDice(tokenSort(left), tokenSort(right)));
        }
    }

    for (const [tagged, other] of [
        [needleRaw, candidateRaw],
        [candidateRaw, needleRaw]
    ] as const) {
        const tags = structuralTags(tagged);
        if (tags.size === 0) {
            continue;
        }
        const otherTokens = tagTokens(other);
        if ([...tags].some(token => !otherTokens.has(token))) {
            best = Math.min(best, AUTO_THRESHOLD - 0.04);
        }
    }
    return best;
}

export type MatchConfidence = 'auto' | 'review' | 'none';

export const AUTO_THRESHOLD = 0.92;
export const REVIEW_THRESHOLD = 0.6;

export function confidenceFor(score: number | undefined): MatchConfidence {
    if (score === undefined) {
        return 'none';
    }
    if (score >= AUTO_THRESHOLD) {
        return 'auto';
    }
    if (score >= REVIEW_THRESHOLD) {
        return 'review';
    }
    return 'none';
}
