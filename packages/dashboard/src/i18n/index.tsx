/**
 * Minimal i18n: flat dictionaries + context provider. The language lives in
 * the server settings (SQLite) so it survives reloads and browsers; English
 * is the default until the user picks otherwise.
 */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { en } from './en.js';
import { fr } from './fr.js';

type Dictionary = typeof en;

/** Local seed so French users do not get an English flash on every load. */
const STORAGE_KEY = 'tanko-language';

export type UiLanguage = 'en' | 'fr';

export const LANGUAGES: Array<{ value: UiLanguage; label: string }> = [
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' }
];

const dictionaries: Record<UiLanguage, Dictionary> = { en, fr };

/** Translate `key` in the active language, interpolating `{param}` placeholders. */
export type TFunction = (key: keyof Dictionary, params?: Record<string, string | number>) => string;

interface I18nApi {
    language: UiLanguage;
    setLanguage: (language: UiLanguage) => void;
    t: TFunction;
    /** Short date+time formatted for the active language. */
    formatDate: (iso?: string) => string;
}

const I18nContext = createContext<I18nApi | null>(null);

export function useI18n(): I18nApi {
    const value = useContext(I18nContext);
    if (!value) {
        throw new Error('useI18n() must be used inside <I18nProvider>');
    }
    return value;
}

export function I18nProvider({ children }: { children: ReactNode }) {
    const [language, setLanguageState] = useState<UiLanguage>(() => (localStorage.getItem(STORAGE_KEY) === 'fr' ? 'fr' : 'en'));
    const userChose = useRef(false);

    // hydrate once at boot from the persisted server setting (a user choice always wins)
    useEffect(() => {
        api.settings()
            .then(settings => {
                if (!userChose.current) {
                    setLanguageState(settings.uiLanguage);
                }
            })
            .catch(() => undefined);
    }, []);

    const setLanguage = (next: UiLanguage) => {
        userChose.current = true;
        setLanguageState(next);
        localStorage.setItem(STORAGE_KEY, next);
        api.updateSettings({ uiLanguage: next }).catch(() => undefined);
    };

    const t = useMemo<TFunction>(
        () => (key, params) => {
            let text: string = dictionaries[language][key] ?? en[key] ?? String(key);
            if (params) {
                for (const [name, value] of Object.entries(params)) {
                    text = text.split(`{${name}}`).join(String(value));
                }
            }
            return text;
        },
        [language]
    );

    const formatDate = useMemo(
        () => (iso?: string) => {
            if (!iso) {
                return '—';
            }
            return new Date(iso).toLocaleString(language === 'fr' ? 'fr-FR' : 'en-GB', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        },
        [language]
    );

    return <I18nContext.Provider value={{ language, setLanguage, t, formatDate }}>{children}</I18nContext.Provider>;
}
