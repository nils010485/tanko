/**
 * Language filtering: connector tags carry human language names ('english',
 * 'french', ...) while chapters carry ISO codes ('en', 'fr'). Both are
 * normalized to ISO 639-1 so a single preferred-language list applies to
 * source selection (import matching) and chapter ingestion (library/import).
 */

const TAG_TO_ISO: Record<string, string> = {
    english: 'en',
    french: 'fr',
    spanish: 'es',
    portuguese: 'pt',
    turkish: 'tr',
    italian: 'it',
    german: 'de',
    russian: 'ru',
    japanese: 'ja',
    korean: 'ko',
    chinese: 'zh',
    polish: 'pl',
    thai: 'th',
    vietnamese: 'vi',
    indonesian: 'id',
    arabic: 'ar',
    hindi: 'hi',
    dutch: 'nl',
    swedish: 'sv'
};

/** Normalize a raw language value (tag word or ISO code) to ISO 639-1. */
export function normalizeLanguage(value: string): string | undefined {
    const lower = value.trim().toLowerCase();
    if (!lower) {
        return undefined;
    }
    if (TAG_TO_ISO[lower]) {
        return TAG_TO_ISO[lower];
    }
    const match = lower.match(/^[a-z]{2}(?:-[a-z]{2})?/);
    return match ? match[0].slice(0, 2) : undefined;
}

/** Parse a comma-separated list ("en,fr") into normalized ISO codes. */
export function parseLanguageList(raw: string | undefined | null): string[] {
    if (!raw) {
        return [];
    }
    return [
        ...new Set(
            raw
                .split(',')
                .map(normalizeLanguage)
                .filter((value): value is string => Boolean(value))
        )
    ];
}

/** ISO codes declared by a source via its tags ('multi-lingual' => undefined = unknown). */
export function sourceLanguages(tags: string[]): string[] | undefined {
    const codes = new Set<string>();
    for (const tag of tags) {
        if (tag.toLowerCase() === 'multi-lingual') {
            return undefined;
        }
        const iso = normalizeLanguage(tag);
        if (iso) {
            codes.add(iso);
        }
    }
    return codes.size > 0 ? [...codes] : undefined;
}

/** A source is usable when it has no declared language, is multi-lingual, or matches a preferred language. */
export function sourceUsable(tags: string[], preferred: string[]): boolean {
    if (preferred.length === 0) {
        return true;
    }
    const languages = sourceLanguages(tags);
    return languages === undefined || languages.some(code => preferred.includes(code));
}
/** Tags marking a source as adult-only (HakuNeko connectors + native adapters). */
const ADULT_TAGS = new Set(['hentai', 'porn', 'adult']);

/** A source is adult when its tags carry one of the adult markers. */
export function isAdultSource(tags: readonly string[]): boolean {
    return tags.some(tag => ADULT_TAGS.has(tag.toLowerCase()));
}

/** A source stays listed unless adult sources are hidden and this one is adult. */
export function adultAllowed(tags: readonly string[], hideAdult: boolean): boolean {
    return !hideAdult || !isAdultSource(tags);
}

/** A chapter is kept when its language is unknown or preferred. */
export function chapterAllowed(language: string | undefined, preferred: string[]): boolean {
    if (preferred.length === 0 || !language) {
        return true;
    }
    const iso = normalizeLanguage(language);
    return iso === undefined || preferred.includes(iso);
}

/** A search result is kept when its languages are unknown or intersect the
 *  preferred ones. Sources that can't tell (legacy) return undefined and pass. */
export function mangaLanguagesAllowed(languages: string[] | undefined, preferred: string[]): boolean {
    if (preferred.length === 0 || !languages || languages.length === 0) {
        return true;
    }
    return languages.some(language => preferred.includes(normalizeLanguage(language) || ''));
}
