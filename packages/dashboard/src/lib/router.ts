/**
 * Tiny hash router: the active tab survives reloads and is shareable
 * (e.g. #/library). No dependency needed for a flat tab structure.
 */
import { useCallback, useEffect, useState } from 'react';

export function useHashRoute<T extends string>(fallback: T, valid: readonly T[]): [T, (tab: T) => void] {
    const read = useCallback((): T => {
        const hash = window.location.hash.replace(/^#\/?/, '');
        return valid.includes(hash as T) ? (hash as T) : fallback;
    }, [fallback, valid]);

    const [route, setRoute] = useState<T>(read);

    useEffect(() => {
        const onChange = () => setRoute(read());
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, [read]);

    const navigate = (tab: T) => {
        if (tab === route) return;
        window.location.hash = `/${tab}`;
        setRoute(tab);
    };

    return [route, navigate];
}
