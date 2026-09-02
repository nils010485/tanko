/**
 * Language normalization helpers: source usability and chapter/title filtering
 * against the preferred-language list.
 */
import { describe, expect, it } from 'vitest';
import { adultAllowed, chapterAllowed, isAdultSource, mangaLanguagesAllowed, normalizeLanguage, sourceUsable } from '../src/languages.js';

describe('normalizeLanguage', () => {
    it('maps tag words and ISO codes, including regional variants', () => {
        expect(normalizeLanguage('english')).toBe('en');
        expect(normalizeLanguage('fr')).toBe('fr');
        expect(normalizeLanguage('pt-br')).toBe('pt');
        expect(normalizeLanguage('??')).toBeUndefined();
    });
});

describe('sourceUsable', () => {
    it('multi-lingual and untagged sources always pass', () => {
        expect(sourceUsable(['multi-lingual'], ['en'])).toBe(true);
        expect(sourceUsable([], ['en'])).toBe(true);
    });

    it('a single-language source must match a preferred language', () => {
        expect(sourceUsable(['french'], ['en'])).toBe(false);
        expect(sourceUsable(['french'], ['en', 'fr'])).toBe(true);
    });
});

describe('isAdultSource', () => {
    it('detects the adult marker tags used by connectors and native adapters', () => {
        expect(isAdultSource(['hentai'])).toBe(true);
        expect(isAdultSource(['manga', 'porn', 'english'])).toBe(true);
        expect(isAdultSource(['hentai', 'adult', 'english'])).toBe(true);
        expect(isAdultSource(['manga', 'english'])).toBe(false);
        expect(isAdultSource([])).toBe(false);
    });

    it('adultAllowed drops adult sources only when they are hidden', () => {
        expect(adultAllowed(['hentai'], true)).toBe(false);
        expect(adultAllowed(['manga', 'english'], true)).toBe(true);
        expect(adultAllowed(['hentai'], false)).toBe(true);
    });
});

describe('chapterAllowed', () => {
    it('keeps unknown languages and drops non-preferred ones', () => {
        expect(chapterAllowed(undefined, ['en'])).toBe(true);
        expect(chapterAllowed('pt-br', ['pt'])).toBe(true);
        expect(chapterAllowed('pl', ['en'])).toBe(false);
    });
});

describe('mangaLanguagesAllowed', () => {
    it('passes when languages are unknown or no preference is set', () => {
        expect(mangaLanguagesAllowed(undefined, ['en'])).toBe(true);
        expect(mangaLanguagesAllowed([], ['en'])).toBe(true);
        expect(mangaLanguagesAllowed(['fr'], [])).toBe(true);
    });

    it('requires an intersection otherwise (regional codes normalize)', () => {
        expect(mangaLanguagesAllowed(['pl', 'pt-br', 'fr', 'it'], ['en'])).toBe(false);
        expect(mangaLanguagesAllowed(['pl', 'pt-br', 'fr', 'it'], ['fr'])).toBe(true);
        expect(mangaLanguagesAllowed(['pt-br'], ['pt'])).toBe(true);
    });
});
