/**
 * Tiny hash router: the active tab survives reloads and is shareable
 * (e.g. #/library). Sub-routes extend the tab path (#/library/42 opens the
 * series view) without extra dependencies.
 */
import { useCallback, useEffect, useState } from 'react';

function readHash(): string {
    return window.location.hash.replace(/^#\/?/, '');
}

/** State derived from the hash, re-evaluated on every hashchange. */
function useHashValue<T>(read: () => T): T {
    const [value, setValue] = useState<T>(read);
    useEffect(() => {
        const onChange = () => setValue(read());
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, [read]);
    return value;
}

export function useHashRoute<T extends string>(fallback: T, valid: readonly T[]): [T, (tab: T) => void] {
    const read = useCallback((): T => {
        const [path] = readHash().split('/');
        return valid.includes(path as T) ? (path as T) : fallback;
    }, [fallback, valid]);
    const route = useHashValue(read);

    // navigating to the current tab also drops any sub-route (#/library/42 → #/library)
    const navigate = (tab: T) => {
        if (window.location.hash === `#/${tab}`) {
            return;
        }
        window.location.hash = `/${tab}`;
    };

    return [route, navigate];
}

/** Series deep-link: #/library/42 opens that series, null closes it. */
export function useHashSeriesId(): [number | null, (id: number | null) => void] {
    const read = useCallback((): number | null => {
        const [tab, param] = readHash().split('/');
        return tab === 'library' && param && /^\d+$/.test(param) ? Number(param) : null;
    }, []);
    const seriesId = useHashValue(read);

    const navigateSeries = (id: number | null) => {
        window.location.hash = id === null ? '/library' : `/library/${id}`;
    };

    return [seriesId, navigateSeries];
}
